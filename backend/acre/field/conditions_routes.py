"""Effective field measurements, local baselines and crop-condition assessments."""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from acre.api.routes import LocationIn, _invalid_for, _loc_args, _meta
from acre.compare import locations
from acre.field.conditions import effective_conditions
from acre.field.conditions_research import assess
from acre.field.equipment import Reading
from acre.field.soilgrids import get_soilgrids
from acre.report.meta import response_meta
from acre.research import client

router = APIRouter(prefix="/v1/field/conditions", tags=["field"])


class ConditionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location: LocationIn
    readings: Annotated[list[Reading], Field(max_length=500)] = Field(default_factory=list)
    crops: Annotated[list[Annotated[str, Field(min_length=1, max_length=80)]], Field(max_length=30)] = Field(default_factory=list)
    region_key: str = Field(default="unknown", max_length=120)
    as_of: date = Field(default_factory=date.today)


@router.post("")
def conditions(body: ConditionsRequest):
    choice = locations.choose(**_loc_args(body.location))
    if choice.kind == "invalid":
        return _invalid_for(choice.issues, choice)
    soil = None
    if body.location.latitude is not None and body.location.longitude is not None:
        soil = get_soilgrids(body.location.latitude, body.location.longitude)
    result = effective_conditions(body.readings, ctx=choice.ctx, soil=soil, at=body.as_of)
    meta = _meta(None, choice.ctx.snapshot_hash, choice.ctx).model_dump(mode="json") if choice.ctx else response_meta(weather=False)
    assessment = assess(result, body.crops, body.region_key)
    can_assess = client.configured()
    if not can_assess and assessment["status"] == "unavailable":
        assessment["reason_text"] = "AI assessment is not configured on this server. Your measurements are still used."
    return {"meta": meta, "status": "complete", **result, "can_assess": can_assess,
            "assessment": assessment}


@router.post("/assess")
def assess_conditions(body: ConditionsRequest):
    choice = locations.choose(**_loc_args(body.location))
    if choice.kind == "invalid":
        return _invalid_for(choice.issues, choice)
    # AI sees only crop and variable definitions; all classification uses values locally.
    soil = None
    if body.location.latitude is not None and body.location.longitude is not None:
        soil = get_soilgrids(body.location.latitude, body.location.longitude)
    result = effective_conditions(body.readings, ctx=choice.ctx, soil=soil, at=body.as_of)
    meta = _meta(None, choice.ctx.snapshot_hash, choice.ctx).model_dump(mode="json") if choice.ctx else response_meta(weather=False)
    assessment = assess(result, body.crops, body.region_key, allow_research=True)
    job_id = assessment.pop("_research_job_id", None)
    return {"meta": meta, "assessment": assessment, "job_id": job_id,
            "job_status": "ready", "check": {"kind": "field_conditions"} if job_id else None}
