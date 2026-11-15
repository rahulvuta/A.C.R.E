"""``POST /v1/scenarios/simulate`` (S1, S2; contract §11) and ``GET /v1/vocab/priorities`` (§16).

Field geometry, readings and economics are request data only: never logged, never stored.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, field_validator

from acre.api.routes import LocationIn, _invalid_for, _issues_from_plan_error, _loc_args, _meta
from acre.compare import engine, text
from acre.compare import locations as places
from acre.contracts import InvalidPlanError, Plan
from acre.farms.geometry import GeometryError, parse_field
from acre.report.http import issue
from acre.report.meta import response_meta
from acre.simulate import compare as sim_compare
from acre.simulate.engine import Inputs, Scenario, readings_context, simulate
from acre.simulate.money import MoneyInputError
from acre.simulate.vocab import PRIORITIES, priorities_vocab
from acre.weather.snapshot import set_active_snapshot_dir

router = APIRouter(prefix="/v1", tags=["simulate"])

MAX_SCENARIOS = 6


class SimGoalsIn(BaseModel):
    model_config = ConfigDict(extra="allow")
    priorities: dict[str, Annotated[int, Field(ge=0, le=3)]] = Field(default_factory=dict)

    @field_validator("priorities")
    @classmethod
    def _known(cls, v: dict[str, int]) -> dict[str, int]:
        if set(v) - set(PRIORITIES):
            raise ValueError(f"unknown priority; known priorities: {', '.join(PRIORITIES)}")
        return v


class ReadingIn(BaseModel):
    """Contract §14. A farmer's own reading: shown beside modeled values, never mixed in."""

    model_config = ConfigDict(extra="ignore")
    date: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]
    kind: Literal["soil_moisture_pct", "soil_moisture_vwc", "rainfall_mm", "soil_temp_c", "note"]
    value: float | None = None
    depth_cm: Annotated[float | None, Field(ge=0, le=500)] = None
    note: Annotated[str | None, Field(max_length=500)] = None


class FieldSimIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    field_id: Annotated[str | None, Field(max_length=100)] = None
    name: Annotated[str | None, Field(max_length=200)] = None
    area_ha: Annotated[float | None, Field(gt=0, le=1_000_000)] = None
    geometry: dict[str, Any] | None = None
    equipment: Annotated[list[Annotated[str, Field(max_length=100)]], Field(max_length=50)] = \
        Field(default_factory=list)  # fmt: skip
    readings: Annotated[list[ReadingIn], Field(max_length=500)] = Field(default_factory=list)


class LossIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dry_spring_pct: Annotated[float | None, Field(ge=0, le=100)] = None
    heavy_rain_pct: Annotated[float | None, Field(ge=0, le=100)] = None


class EconomicsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    overrides: Annotated[dict[str, dict[str, Any]], Field(max_length=60)] = Field(default_factory=dict)
    loss_assumptions: LossIn = Field(default_factory=LossIn)


class ScenarioIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_id: Annotated[str, Field(min_length=1, max_length=64)]
    label: Annotated[str | None, Field(max_length=120)] = None
    is_baseline: bool = False
    rotation: Annotated[list[Plan], Field(min_length=1, max_length=4)]


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location: LocationIn | None = None
    location_id: str | None = None
    field: FieldSimIn = Field(default_factory=FieldSimIn)
    goals: SimGoalsIn = Field(default_factory=SimGoalsIn)
    economics: EconomicsIn = Field(default_factory=EconomicsIn)
    scenarios: Annotated[list[ScenarioIn], Field(min_length=1, max_length=MAX_SCENARIOS)]
    years: Annotated[int, Field(ge=1, le=10)] = 10
    runs: Annotated[int, Field(ge=50, le=500)] = 200
    seed: Annotated[int, Field(ge=0, le=2**31 - 1)] = 7
    start_season: Annotated[str, Field(pattern=r"^\d{4}$")] = "2027"


def _result_id(body: SimulateRequest) -> str:
    doc = body.model_dump(mode="json", exclude={"field": {"readings", "geometry", "name"}})
    return "sim_" + hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest()[:16]


def validate(body: SimulateRequest) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    ids = [s.scenario_id for s in body.scenarios]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        issues.append(issue("scenarios", "duplicate_scenario_id", "scenario ids must be unique"))
    if sum(s.is_baseline for s in body.scenarios) > 1:
        issues.append(issue("scenarios", "two_baselines", "at most one scenario is the baseline"))
    for i, s in enumerate(body.scenarios):
        for j, p in enumerate(s.rotation):
            try:
                engine.build_calendar(p, engine.REFERENCE_YEAR)
            except InvalidPlanError as exc:
                issues += _issues_from_plan_error(exc, f"scenarios.{i}.rotation.{j}")
    if not 1981 <= int(body.start_season) <= 2100:
        issues.append(issue("start_season", "invalid_start_season",
                            "start_season is a year between 1981 and 2100"))  # fmt: skip
    if body.field.area_ha is None and body.field.geometry is not None:
        try:
            parse_field(body.field.geometry)
        except GeometryError as exc:
            issues.append(issue("field.geometry", exc.code, str(exc)))
    if any(set(ov) - {"price", "yield", "costs"} for ov in body.economics.overrides.values()):
        issues.append(issue("economics.overrides", "unknown_override",
                            "each crop override has only price, yield and costs"))  # fmt: skip
    return issues


@router.post("/scenarios/simulate")
def simulate_scenarios(body: SimulateRequest) -> Any:
    choice = places.choose(body.location_id, **_loc_args(body.location))
    if choice.ok and choice.entry is not None:
        set_active_snapshot_dir(choice.entry.directory)
    if choice.kind == "invalid":
        return _invalid_for(choice.issues, choice)
    issues = validate(body)
    if issues:
        return _invalid_for(issues, choice)
    if not choice.ok:
        rt = text.reason_text(choice.reason)
        return {"meta": _meta(None, None).model_dump(), "status": "unavailable",
                "code": choice.code, "reason": choice.reason, "reason_text": rt,
                "weather_location": places.weather_location(choice, rt).model_dump(mode="json"),
                "method": {"weather": "historical_resampling", "note": "Replays real past "
                           "weather in new orders; not a forecast."},
                "scenarios": [], "comparison": None}  # fmt: skip
    ctx = choice.ctx
    assert ctx is not None
    f = body.field
    area = f.area_ha
    area_origin = "grower" if area is not None else None
    if area is None and f.geometry is not None:
        area, area_origin = parse_field(f.geometry).area_ha, "calculation"
    has_base = any(s.is_baseline for s in body.scenarios)
    scs = [Scenario(s.scenario_id, s.label, list(s.rotation),
                    s.is_baseline or (not has_base and i == 0))
           for i, s in enumerate(body.scenarios)]  # fmt: skip
    loc = (body.location.model_dump(exclude_none=True) if body.location else {})
    inp = Inputs(scs, body.years, body.runs, body.seed, int(body.start_season), area,
                 list(f.equipment), body.economics.overrides,
                 body.economics.loss_assumptions.model_dump(), loc)  # fmt: skip
    try:
        out = simulate(ctx, inp)
    except MoneyInputError as exc:
        return _invalid_for([issue(f"economics.{exc.field}", exc.code, str(exc))], choice)
    out.pop("_matrices", None)
    readings = readings_context([r.model_dump() for r in f.readings], ctx)
    for sc in out["scenarios"]:
        sc["readings_context"] = readings
    comparison = (sim_compare.compare(out["scenarios"], body.goals.priorities, body.years)
                  if out["scenarios"] else None)  # fmt: skip
    rid = _result_id(body)
    return {"meta": _meta(rid, ctx.snapshot_hash, ctx).model_dump(), **out,
            "field": {"field_id": f.field_id, "area_ha": round(area, 3) if area else None,
                      "area_origin": area_origin},
            "weather_location": places.weather_location(choice).model_dump(mode="json"),
            "comparison": comparison}  # fmt: skip


@router.get("/vocab/priorities")
def get_vocab_priorities() -> Any:
    return {"meta": response_meta(weather=False), "status": "complete",
            "priorities": priorities_vocab()}  # fmt: skip
