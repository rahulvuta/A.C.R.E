"""``POST /v1/plans/recommend`` (P2, contract §9): goals + field -> candidates -> shortlist."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, field_validator

from acre.api.routes import (
    LocationIn,
    _invalid_for,
    _issues_from_plan_error,
    _loc_args,
    _meta,
)
from acre.compare import engine, text
from acre.compare import locations as places
from acre.compare.indicators import PRIORITIES
from acre.compare.recommend import Candidate, generate, recommend
from acre.contracts import InvalidPlanError, Plan
from acre.report.http import issue
from acre.weather.snapshot import set_active_snapshot_dir

router = APIRouter(prefix="/v1/plans", tags=["recommend"])

MAX_CANDIDATES = 50


class GoalsIn(BaseModel):
    """Contract §8. Only ``priorities`` is read here; constraints and preferences go to the
    candidate generator (P1). Unknown stays unknown: nothing is defaulted to "no"."""

    model_config = ConfigDict(extra="allow")
    priorities: dict[str, Annotated[int, Field(ge=0, le=3)]] = Field(default_factory=dict)
    constraints: dict[str, Any] = Field(default_factory=dict)
    preferences: dict[str, Any] = Field(default_factory=dict)

    @field_validator("priorities")
    @classmethod
    def _known(cls, v: dict[str, int]) -> dict[str, int]:
        if set(v) - set(PRIORITIES) - {"profit"}:  # unknown names are not echoed (client text)
            raise ValueError(f"unknown priority; known priorities: {', '.join(PRIORITIES)}, profit")
        return {k: w for k, w in v.items() if k != "profit"}  # no money here: profit is simulate's


class CandidateIn(BaseModel):
    """A farmer-edited candidate: one plan per season (1-4)."""

    model_config = ConfigDict(extra="forbid")
    candidate_id: Annotated[str, Field(min_length=1)]
    label: str | None = None
    plans: Annotated[list[Plan], Field(min_length=1, max_length=4)]


class RecommendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location: LocationIn | None = None
    location_id: str | None = None
    field: dict[str, Any] = Field(default_factory=dict)
    goals: GoalsIn = Field(default_factory=GoalsIn)
    candidates: Annotated[list[CandidateIn] | None, Field(max_length=MAX_CANDIDATES)] = None


def _gen_location(loc: LocationIn | None, choice: places.Choice) -> dict[str, Any]:
    """The location handed to the generator: the request's point or cell, else the place's."""
    if loc is not None:
        return {k: v for k, v in loc.model_dump().items() if v is not None}
    e = choice.entry or (choice.ctx.place if choice.ctx else None)
    return {"latitude": e.latitude, "longitude": e.longitude} if e is not None else {}


@router.post("/recommend")
def recommend_plans(body: RecommendRequest) -> Any:
    choice = places.choose(body.location_id, **_loc_args(body.location))
    if choice.ok and choice.entry is not None:
        set_active_snapshot_dir(choice.entry.directory)
    if choice.kind == "invalid":
        return _invalid_for(choice.issues, choice)
    if body.candidates is not None:
        ids = [c.candidate_id for c in body.candidates]
        dup = sorted({i for i in ids if ids.count(i) > 1})
        if dup:
            return _invalid_for([issue("candidates", "duplicate_candidate_id",
                                       f"candidate ids must be unique: {dup}")], choice)  # fmt: skip
        issues = []
        for i, c in enumerate(body.candidates):
            for j, p in enumerate(c.plans):
                try:
                    engine.build_calendar(p, engine.REFERENCE_YEAR)
                except InvalidPlanError as exc:
                    issues += _issues_from_plan_error(exc, f"candidates.{i}.plans.{j}")
        if issues:
            return _invalid_for(issues, choice)
    if not choice.ok:
        rt = text.reason_text(choice.reason)
        return {
            "meta": _meta(None, None).model_dump(), "status": "unavailable",
            "reason": choice.reason, "code": choice.code, "reason_text": rt,
            "weather_location": places.weather_location(choice, rt).model_dump(mode="json"),
            "shortlist": [], "not_comparable": [], "dominated": [], "generation_log": [],
            "gaps": [],
        }  # fmt: skip
    ctx = choice.ctx
    assert ctx is not None
    if body.candidates is not None:
        cands = [Candidate(c.candidate_id, list(c.plans), c.label, "grower")
                 for c in body.candidates]  # fmt: skip
        gen: dict[str, Any] = {"status": "complete", "generation_log": [], "gaps": []}
    else:
        gen = generate(ctx, _gen_location(body.location, choice), body.field,
                       body.goals.model_dump())  # fmt: skip
        if gen.get("status") == "invalid_input":
            return _invalid_for(gen["issues"], choice)
        cands = gen["candidates"][:MAX_CANDIDATES]
    base = {"generation_log": gen.get("generation_log", []), "gaps": list(gen.get("gaps", [])),
            "weather_location": places.weather_location(choice).model_dump(mode="json")}  # fmt: skip
    if not cands:  # keep the generator's own status and reason (unavailable stays unavailable)
        st = gen.get("status") if gen.get("status") in ("unavailable", "insufficient_data") \
            else "insufficient_data"
        reason = gen.get("reason")
        return {"meta": _meta(None, ctx.snapshot_hash, ctx).model_dump(), "status": st,
                "reason": reason, "reason_text": gen.get("reason_text") or text.reason_text(reason),
                "shortlist": [], "not_comparable": [], "dominated": [], **base}  # fmt: skip
    requested = body.location.model_dump() if body.location else None
    out = recommend(cands, ctx, body.goals.priorities, soil=body.field.get("soil"),
                    requested=requested)  # fmt: skip
    return {"meta": _meta(out["result_id"], ctx.snapshot_hash, ctx).model_dump(), **out, **base}
