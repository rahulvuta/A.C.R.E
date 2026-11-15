"""``POST /v1/scenarios/simulate`` (S1, S2; contract §11) and ``GET /v1/vocab/priorities`` (§16).

Field geometry, readings and economics are request data only: never logged, never stored.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from acre.api.routes import LocationIn, _invalid_for, _issues_from_plan_error, _loc_args, _meta
from acre.compare import engine, text
from acre.compare import locations as places
from acre.contracts import MAX_ROTATION_LEGS, InvalidPlanError, Plan
from acre.farms.geometry import GeometryError, parse_field
from acre.field.conditions import effective_conditions
from acre.field.conditions_research import assess
from acre.field.equipment import Reading, check_equipment
from acre.report.http import issue
from acre.report.meta import response_meta
from acre.simulate import compare as sim_compare
from acre.simulate.autofill import autofill
from acre.simulate.demo import demo_farm
from acre.simulate.engine import Inputs, Scenario, Zone, readings_context, simulate
from acre.simulate.money import MoneyInputError
from acre.simulate.vocab import OUTLOOK_NOTE, PRIORITIES, priorities_vocab
from acre.weather.ondemand import Cell, CellIdError
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


class ReadingIn(Reading):
    """A grower's measurement, preferred to a compatible estimate for this field."""

    model_config = ConfigDict(extra="ignore")


MAX_ZONES = 20


class ZoneIn(BaseModel):
    """One part of the field with its own plan. Give its size as ``share`` (of the field),
    ``area_ha`` or a drawn ``geometry`` (all zones of a field use the same one)."""

    model_config = ConfigDict(extra="ignore")
    zone_id: Annotated[str, Field(min_length=1, max_length=64)]
    name: Annotated[str | None, Field(max_length=120)] = None
    share: Annotated[float | None, Field(gt=0, le=1)] = None
    area_ha: Annotated[float | None, Field(gt=0, le=1_000_000)] = None
    geometry: dict[str, Any] | None = None  # never logged or echoed


class FieldSimIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    field_id: Annotated[str | None, Field(max_length=100)] = None
    region_key: str = Field(default="unknown", max_length=120)
    name: Annotated[str | None, Field(max_length=200)] = None
    area_ha: Annotated[float | None, Field(gt=0, le=1_000_000)] = None
    geometry: dict[str, Any] | None = None
    equipment: Annotated[list[Annotated[str, Field(max_length=100)]], Field(max_length=50)] = \
        Field(default_factory=list)  # fmt: skip
    readings: Annotated[list[ReadingIn], Field(max_length=500)] = Field(default_factory=list)
    zones: Annotated[list[ZoneIn], Field(max_length=MAX_ZONES)] = Field(default_factory=list)

    @field_validator("equipment")
    @classmethod
    def _equipment(cls, value: list[str]) -> list[str]:
        return check_equipment(value)


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
    # the whole field's rotation, or the default for zones with no entry in ``zone_rotations``
    rotation: Annotated[list[Plan], Field(min_length=1, max_length=MAX_ROTATION_LEGS)] | None = None
    zone_rotations: dict[
        str, Annotated[list[Plan], Field(min_length=1, max_length=MAX_ROTATION_LEGS)]
    ] = Field(default_factory=dict)


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
    climate: Literal["none", "trend"] = "trend"  # "trend": rain follows the trend seen in the record


def _result_id(body: SimulateRequest) -> str:
    doc = body.model_dump(mode="json")
    for z in doc["field"]["zones"]:
        z.pop("geometry", None)
        z.pop("name", None)
    doc["field"]["readings"] = [
        {k: v for k, v in r.items() if k != "note"}
        for r in doc["field"]["readings"] if r["kind"] != "note"]
    if not doc["field"]["readings"]:
        doc["field"].pop("readings")
    for k in ("geometry", "name"):
        doc["field"].pop(k, None)
    return "sim_" + hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest()[:16]


def validate(body: SimulateRequest) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    ids = [s.scenario_id for s in body.scenarios]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        issues.append(issue("scenarios", "duplicate_scenario_id", "scenario ids must be unique"))
    if sum(s.is_baseline for s in body.scenarios) > 1:
        issues.append(issue("scenarios", "two_baselines", "at most one scenario is the baseline"))
    zone_ids = [z.zone_id for z in body.field.zones]
    issues += _zone_issues(body)
    for i, s in enumerate(body.scenarios):
        if s.rotation is None and not body.field.zones:
            issues.append(issue(f"scenarios.{i}.rotation", "rotation_missing",
                                "give a rotation (or define zones on the field)"))  # fmt: skip
        elif body.field.zones and s.rotation is None and set(zone_ids) - set(s.zone_rotations):
            issues.append(issue(f"scenarios.{i}.zone_rotations", "zone_rotation_missing",
                                "give every zone a rotation, or a default rotation"))  # fmt: skip
        if s.zone_rotations and not body.field.zones:
            issues.append(issue(f"scenarios.{i}.zone_rotations", "zone_rotations_without_zones",
                                "define the field's zones first"))  # fmt: skip
        elif set(s.zone_rotations) - set(zone_ids):
            issues.append(issue(f"scenarios.{i}.zone_rotations", "unknown_zone",
                                "zone_rotations names a zone the field does not have"))  # fmt: skip
        legs = ([("rotation", s.rotation)] if s.rotation else []) + [
            (f"zone_rotations.{z}", r) for z, r in s.zone_rotations.items()]
        for where, rot in legs:
            for j, p in enumerate(rot):
                try:
                    engine.build_calendar(p, engine.REFERENCE_YEAR)
                except InvalidPlanError as exc:
                    issues += _issues_from_plan_error(exc, f"scenarios.{i}.{where}.{j}")
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


def _zone_issues(body: SimulateRequest) -> list[dict[str, str]]:
    zs = body.field.zones
    out: list[dict[str, str]] = []
    if not zs:
        return out
    ids = [z.zone_id for z in zs]
    if len(set(ids)) != len(ids):
        out.append(issue("field.zones", "duplicate_zone_id", "zone ids must be unique"))
    basis = [{n for n in ("share", "area_ha", "geometry") if getattr(z, n) is not None} for z in zs]
    if any(len(b) != 1 for b in basis):
        out.append(issue("field.zones", "zone_size_missing",
                         "give each zone exactly one of share, area_ha or geometry"))  # fmt: skip
        return out
    if len({next(iter(b)) for b in basis}) > 1:
        out.append(issue("field.zones", "zones_mixed_size",
                         "give every zone its size the same way (share, area_ha or geometry)"))  # fmt: skip
        return out
    kind = next(iter(basis[0]))
    if kind == "share":
        if abs(sum(z.share or 0 for z in zs) - 1.0) > 0.01:
            out.append(issue("field.zones", "zones_share_sum", "zone shares must add up to 1"))
        return out
    try:
        areas = _zone_areas(zs)
    except GeometryError as exc:
        return [issue("field.zones", exc.code, str(exc))]
    field_ha = body.field.area_ha
    if field_ha is None and body.field.geometry is not None:
        try:
            field_ha = parse_field(body.field.geometry).area_ha
        except GeometryError:
            field_ha = None
    if field_ha is not None and sum(areas) > field_ha * 1.02:
        out.append(issue("field.zones", "zones_exceed_field",
                         "the zones add up to more than the field's area"))  # fmt: skip
    return out


def _zone_areas(zs: list[ZoneIn]) -> list[float]:
    return [z.area_ha if z.area_ha is not None else parse_field(z.geometry or {}).area_ha
            for z in zs]


def _build_zones(body: SimulateRequest, field_ha: float | None) -> tuple[
        list[tuple[ZoneIn, float | None, float]], float | None]:  # fmt: skip
    """(zone, area in ha, weight) per zone, and the area of the zoned part of the field."""
    zs = body.field.zones
    if zs[0].share is not None:
        total = sum(z.share or 0 for z in zs)
        rows = [(z, field_ha * (z.share or 0) / total if field_ha else None, (z.share or 0) / total)
                for z in zs]  # fmt: skip
        return rows, field_ha
    areas = _zone_areas(zs)
    total = sum(areas)
    return [(z, a, a / total) for z, a in zip(zs, areas, strict=True)], total


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
                "method": {"weather": "historical_resampling", "note": OUTLOOK_NOTE},
                "scenarios": [], "comparison": None}  # fmt: skip
    ctx = choice.ctx
    assert ctx is not None
    f = body.field
    area = f.area_ha
    area_origin = "grower" if area is not None else None
    if area is None and f.geometry is not None:
        area, area_origin = parse_field(f.geometry).area_ha, "calculation"
    zone_rows: list[tuple[ZoneIn, float | None, float]] = []
    if f.zones:
        zone_rows, zoned_ha = _build_zones(body, area)
        if area is None and zoned_ha:  # zones were sized in hectares: they give the field's area
            area, area_origin = zoned_ha, "calculation"
    has_base = any(s.is_baseline for s in body.scenarios)
    scs = []
    for i, s in enumerate(body.scenarios):
        zs = [Zone(z.zone_id, z.name, a, w, list(s.zone_rotations.get(z.zone_id) or s.rotation or []))
              for z, a, w in zone_rows] or None
        first = s.rotation or next(iter(s.zone_rotations.values()))
        scs.append(Scenario(s.scenario_id, s.label, list(first),
                            s.is_baseline or (not has_base and i == 0), zs))
    loc = (body.location.model_dump(exclude_none=True) if body.location else {})
    inp = Inputs(scs, body.years, body.runs, body.seed, int(body.start_season), area,
                 list(f.equipment), body.economics.overrides,
                 body.economics.loss_assumptions.model_dump(), loc, body.climate)  # fmt: skip
    try:
        out = simulate(ctx, inp, readings=list(f.readings))
    except MoneyInputError as exc:
        return _invalid_for([issue(f"economics.{exc.field}", exc.code, str(exc))], choice)
    out.pop("_matrices", None)
    effective = effective_conditions(list(f.readings), ctx=ctx)
    crops = sorted({c for sc in scs for rot in sc.all_rotations() for p in rot
                    for c in (p.previous_crop_id, p.next_crop_id, p.winter.crop_id) if c})
    out["effective_field_conditions"] = effective
    out["condition_assessment"] = assess(effective, crops, f.region_key)
    readings = readings_context([r.model_dump(mode="json") for r in f.readings], ctx)
    for sc in out["scenarios"]:
        sc["readings_context"] = readings
    comparison = (sim_compare.compare(out["scenarios"], body.goals.priorities, body.years)
                  if out["scenarios"] else None)  # fmt: skip
    rid = _result_id(body)
    return {"meta": _meta(rid, ctx.snapshot_hash, ctx).model_dump(), **out,
            "field": {"field_id": f.field_id, "area_ha": round(area, 3) if area else None,
                      "area_origin": area_origin,
                      "zones": [{"zone_id": z.zone_id, "name": z.name,
                                 "area_ha": round(a, 3) if a else None, "share": round(w, 4)}
                                for z, a, w in zone_rows] or None,
                      "unzoned_ha": _unzoned(area, zone_rows)},
            "weather_location": places.weather_location(choice).model_dump(mode="json"),
            "comparison": comparison}  # fmt: skip


def _unzoned(field_ha: float | None, rows: list[tuple[ZoneIn, float | None, float]]) -> float | None:
    """Field area not given to any zone (only when zones were sized in hectares)."""
    if not rows or field_ha is None or rows[0][0].share is not None:
        return None
    left = field_ha - sum(a or 0 for _, a, _ in rows)
    return round(left, 3) if left > field_ha * 0.01 else None


@router.get("/vocab/priorities")
def get_vocab_priorities() -> Any:
    return {"meta": response_meta(weather=False), "status": "complete",
            "priorities": priorities_vocab()}  # fmt: skip


class AutofillCropIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["previous", "cover", "next"]
    crop_id: Annotated[str, Field(min_length=1, max_length=100)]


class AutofillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location: LocationIn
    crops: Annotated[list[AutofillCropIn], Field(min_length=2, max_length=3)]


@router.post("/plans/autofill")
def autofill_plan(body: AutofillRequest) -> Any:
    loc = body.location
    issues = []
    lat, lon = loc.latitude, loc.longitude
    if loc.cell_id is not None:
        if lat is not None or lon is not None:
            issues.append(issue("location", "location_conflict", "Give a point or a cell_id."))
        else:
            try:
                cell = Cell.parse(loc.cell_id)
                lat, lon = cell.center_latitude, cell.center_longitude
            except CellIdError as exc:
                issues.append(issue("location.cell_id", "invalid_cell", str(exc)))
    elif lat is None or lon is None:
        issues.append(issue("location", "incomplete_point", "Give both latitude and longitude."))
    roles = [c.role for c in body.crops]
    if len(roles) != len(set(roles)) or not {"previous", "next"} <= set(roles):
        issues.append(issue("crops", "crop_roles", "Give one previous and one next crop, "
                            "and at most one cover crop."))
    if issues:
        return JSONResponse(status_code=400, content={"status": "invalid_input", "issues": issues,
                            **response_meta(weather=False)})
    assert lat is not None and lon is not None
    return autofill(lat, lon, {c.role: c.crop_id for c in body.crops})


@router.get("/demo/farm")
def get_demo_farm(scenario: Annotated[Literal["union", "pergamino"], Query()] = "union") -> Any:
    return demo_farm(scenario)
