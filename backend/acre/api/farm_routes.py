"""``POST /v1/farms/analyze`` (A3, contract §5). The backend stores no farm data."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from acre.api.recommend_routes import GoalsIn
from acre.compare.models import Meta
from acre.contracts import Plan
from acre.farms.analyze import FieldInput, analyze_farm, validate
from acre.field.equipment import FieldExtras, readings_context
from acre.report.meta import response_meta

router = APIRouter(prefix="/v1/farms", tags=["farms"])

MAX_FIELDS = 50


class FieldIn(FieldExtras):
    model_config = ConfigDict(extra="forbid")
    field_id: Annotated[str, Field(min_length=1, max_length=100)]
    name: str | None = None
    geometry: dict[str, Any]  # GeoJSON Polygon or MultiPolygon; never logged or echoed
    plan: Plan
    goals: GoalsIn | None = None  # optional P1/P2 goals for this field


class FarmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    farm_id: str | None = None
    name: str | None = None
    fields: Annotated[list[FieldIn], Field(min_length=1, max_length=MAX_FIELDS)]


class OptionsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prepare_weather: bool = True  # start POWER fetches for cells with no stored weather
    wait_s: float = Field(default=0.0, ge=0, le=120)  # wait for those fetches (0 = pending)
    include_capabilities: bool = True
    include_soil: bool = False  # accepted for the contract; soil comes with capabilities (B4)
    recommend: bool = False  # run P2 for fields that carry goals


class FarmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    farm: FarmIn
    options: OptionsIn = Field(default_factory=OptionsIn)


class FarmResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    meta: Meta
    farm_id: str | None
    status: str
    fields: list[dict[str, Any]]
    weather_cells: list[dict[str, Any]]
    totals: dict[str, float]
    notes: list[str]


@router.post("/analyze", response_model=FarmResponse)
def analyze(body: FarmRequest) -> Any:
    fields = [FieldInput(i, f.field_id, f.name, f.geometry, f.plan,
                         f.goals.model_dump() if f.goals else None, f.equipment)
              for i, f in enumerate(body.farm.fields)]  # fmt: skip
    measured, issues = validate(fields)
    meta = {**response_meta(), "snapshot_hash": None}  # one farm can span several snapshots
    if issues:
        return JSONResponse(status_code=400,
                            content={"status": "invalid_input", "issues": issues, **meta})  # fmt: skip
    o = body.options
    out = analyze_farm(measured, prepare_weather=o.prepare_weather, wait_s=o.wait_s,
                       include_capabilities=o.include_capabilities, recommend=o.recommend)  # fmt: skip
    by_id = {f.field_id: f for f in body.farm.fields}
    for result in out["fields"]:
        field = by_id[result["field_id"]]
        result["equipment"] = field.equipment
        result["readings_context"] = readings_context(field.readings)
    return {"meta": meta, "farm_id": body.farm.farm_id, **out}
