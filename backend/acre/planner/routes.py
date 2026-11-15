"""Phase 7 HTTP routes: ``POST /v1/plans/check``, ``POST /v1/plans/find``, ``GET /v1/crops``.

Mounted by the API app (owner: Agent A) with ``app.include_router(router)``.
Every response carries ``meta = {plan_version, catalog_version, snapshot_hash, request_id}``.
Invalid input (malformed JSON, a non-object body, a bad field, an impossible chronology) is a 400
with typed ``{field, code, message}`` issues and the same metadata, never a stack trace. A plan that
is *unsupported* (an unknown crop, a region outside NC) is a 200 with ``status: "unsupported"``,
because that is a result about the plan rather than a malformed request.
"""

from __future__ import annotations

import math
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import ValidationError

from acre.compare.context import Context, get_context
from acre.contracts import FieldIssue, Plan
from acre.planner.checker import (
    check_plan,
    default_planting_year,
    map_plan_to_catalog,
    plan_version,
)
from acre.planner.crops import list_crops
from acre.planner.finder import PRIORITIES, find_plans
from acre.planner.wheat_path import demo_plan, evaluate_wheat_double_crop, plan_from_dates
from acre.report.http import invalid, issue, read_object
from acre.report.meta import get_index, response_meta

router = APIRouter(prefix="/v1", tags=["planner"])

MIN_YEAR, MAX_YEAR = 1900, 2200


def _prefixed(i: FieldIssue) -> dict[str, str]:
    """Chronology issues name plan fields; the request field path starts with ``plan.``."""
    return issue(f"plan.{i.field}", i.code, i.message)


def _validation_issues(exc: ValidationError, prefix: str = "") -> list[dict[str, str]]:
    return [
        issue(
            prefix + (".".join(str(p) for p in e["loc"]) or "body"),
            e["type"],
            e["msg"],
        )
        for e in exc.errors()
    ]


def _valid_input_value(v: Any) -> bool:
    """``None`` and blank strings mean "not provided"; anything else must be a finite number."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return True
    if isinstance(v, bool) or not isinstance(v, int | float | str):
        return False
    try:
        return math.isfinite(float(v))
    except (ValueError, OverflowError):
        return False


def _parse_common(body: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Validate ``plan``, ``year`` and ``inputs``. Returns ``(parsed, issues)``."""
    issues: list[dict[str, str]] = []
    plan = None
    try:
        plan = Plan.model_validate(body.get("plan"))
    except ValidationError as exc:
        issues += _validation_issues(exc, "plan.")
    year = body.get("year")
    if year is not None and (
        isinstance(year, bool) or not isinstance(year, int) or not MIN_YEAR <= year <= MAX_YEAR
    ):
        issues.append(
            issue("year", "invalid_year", f"year must be an integer in {MIN_YEAR}-{MAX_YEAR}")
        )
    inputs = body.get("inputs")
    if inputs is not None:
        if not isinstance(inputs, dict):
            issues.append(issue("inputs", "not_an_object", "inputs must be an object"))
        else:
            for k, v in inputs.items():
                if not _valid_input_value(v):
                    issues.append(
                        issue(f"inputs.{k}", "invalid_value", "input values must be finite numbers")
                    )
    if issues:
        return None, issues
    return {"plan": plan, "year": year, "inputs": inputs}, []


def _index_for(body: dict[str, Any]) -> tuple[Any, dict[str, Any] | None, list[dict[str, str]]]:
    """The catalog for the body's optional ``location`` (B2). Without one: the NC catalog."""
    loc = body.get("location")
    if loc is None:
        return get_index(), None, []
    from acre.catalogs.regional import catalog_for_location

    if not isinstance(loc, dict):
        return None, None, [issue("location", "invalid_location", "location must be an object")]
    index, state = catalog_for_location(loc)
    if state is not None and state.get("reason") == "invalid_location":
        return None, None, [issue("location", "invalid_location",
                                  "location needs latitude and longitude within range, or a "
                                  "cell_id")]  # fmt: skip
    return index, state, []


def _with_catalog(out: dict[str, Any], state: dict[str, Any] | None,
                  index: Any = None) -> dict[str, Any]:  # fmt: skip
    """Add the catalog state; a non-NC answer's meta names its own catalog and no snapshot."""
    if state is not None:
        out["catalog"] = state
        if index is not None and getattr(index, "in_nc", True) is False:
            pv = out.get("meta", {}).get("plan_version")
            out["meta"] = response_meta(pv, index=index, weather=False)
    return out


@router.post("/plans/check")
async def post_check(request: Request) -> Any:
    """Body: ``{"plan": Plan, "year": int?, "inputs": {soil_temp_f: ..., ...}?}``."""
    body, err = await read_object(request)
    if err is not None:
        return err
    parsed, issues = _parse_common(body)  # type: ignore[arg-type]
    if parsed is None:
        return invalid(issues)
    plan, inputs = parsed["plan"], parsed["inputs"]
    index, state, loc_issues = _index_for(body)  # type: ignore[arg-type]
    if loc_issues:
        return invalid(loc_issues)
    year = parsed["year"] or default_planting_year()
    result = check_plan(plan, index, year=year, inputs=inputs)
    if result.status == "invalid_input":
        return invalid([_prefixed(i) for i in result.issues])
    return _with_catalog({
        "meta": response_meta(plan_version(plan, result.year, inputs)),
        "result": result.model_dump(mode="json"),
    }, state, index)  # fmt: skip


@router.post("/plans/find")
async def post_find(request: Request) -> Any:
    """Body: ``{"plan": Plan (winter ignored), "priorities": [...]?, "year": int?}``."""
    body, err = await read_object(request)
    if err is not None:
        return err
    parsed, issues = _parse_common(body)  # type: ignore[arg-type]
    priorities = body.get("priorities") if parsed is not None else None
    if parsed is not None and priorities is not None:
        if not isinstance(priorities, list) or any(p not in PRIORITIES for p in priorities):
            issues.append(
                issue(
                    "priorities",
                    "invalid_priority",
                    f"priorities must be a list drawn from {list(PRIORITIES)}; got {priorities!r}",
                )
            )
    if parsed is None or issues:
        return invalid(issues)
    plan, inputs = parsed["plan"], parsed["inputs"]
    index, state, loc_issues = _index_for(body)  # type: ignore[arg-type]
    if loc_issues:
        return invalid(loc_issues)
    year = parsed["year"] or default_planting_year()
    result = find_plans(plan, index, priorities=priorities, year=year, inputs=inputs)
    if result.status == "invalid_input" and result.check is not None:
        return invalid([_prefixed(i) for i in result.check.issues])
    # plan_version excludes priorities on purpose: they only reorder the same facts.
    return _with_catalog({
        "meta": response_meta(plan_version(plan, result.year, inputs)),
        "result": result.model_dump(mode="json"),
    }, state, index)  # fmt: skip


@router.get("/crops")
def get_crops(lat: str | None = None, lon: str | None = None) -> Any:
    """The crops of the NC catalog, or of the catalog at ``lat``/``lon`` (B2)."""
    if lat is None and lon is None:
        out = list_crops(get_index())
        return {"meta": response_meta(), **out.model_dump(mode="json")}
    index, state, problems = _index_for({"location": {"latitude": lat, "longitude": lon}})
    if problems:
        return invalid(problems)
    out = list_crops(index)
    return _with_catalog({"meta": response_meta(), **out.model_dump(mode="json")}, state, index)


# --------------------------------------------------------------------------- wheat double-crop

_WHEAT_FLAT = ("prev_harvest", "wheat_plant", "wheat_harvest", "soybean_plant")
_WHEAT_OPTIONAL = ("previous_crop_id", "region", "production_system", "grower", "plan_id", "label")


@router.get("/plans/wheat/template")
def get_wheat_template() -> dict[str, Any]:
    """Demo dates for the wheat -> double-crop soybean path. ASSUMED, not grower-entered."""
    return {
        "meta": response_meta(),
        "dates_basis": "assumed",
        "plan": demo_plan().model_dump(mode="json"),
        "enter": list(_WHEAT_FLAT),
        "note": "The catalog has no numeric Piedmont wheat windows; the grower enters the dates.",
    }


@router.post("/plans/wheat")
async def post_wheat(request: Request, ctx: Annotated[Context, Depends(get_context)]) -> Any:
    """Wheat -> double-crop soybean. Body: ``{plan}`` (a winter_grain plan) or the flat dates
    ``{prev_harvest, wheat_plant, wheat_harvest, soybean_plant}`` (MM-DD), plus optional
    ``maturity_group``, ``year``, ``inputs``, ``compare_to_plan_id`` or ``compare_to_plan`` (a
    full-season soybean plan, compared as different-calendar only)."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    issues: list[dict[str, str]] = []
    plan: Plan | None = None
    if body.get("plan") is not None:
        try:
            plan = Plan.model_validate(body["plan"])
        except ValidationError as exc:
            issues += _validation_issues(exc, "plan.")
    else:
        missing = [k for k in _WHEAT_FLAT if body.get(k) is None]
        if missing:
            issues += [issue(k, "required", f"{k} is required (MM-DD)") for k in missing]
        else:
            try:
                plan = plan_from_dates(
                    **{k: body[k] for k in _WHEAT_FLAT},
                    **{k: body[k] for k in _WHEAT_OPTIONAL if body.get(k) is not None},
                )
            except ValidationError as exc:
                rename = {"harvest": "wheat_harvest", "plant": "wheat_plant", "winter.harvest": "wheat_harvest",
                          "winter.plant": "wheat_plant", "next_plant": "soybean_plant"}  # fmt: skip
                issues += [
                    {**i, "field": rename.get(i["field"], i["field"])}
                    for i in _validation_issues(exc, "")
                ]
            except TypeError as exc:
                issues.append(issue("body", "invalid_type", str(exc)))
    year = body.get("year")
    if year is not None and (
        isinstance(year, bool) or not isinstance(year, int) or not MIN_YEAR <= year <= MAX_YEAR
    ):
        issues.append(
            issue("year", "invalid_year", f"year must be an integer in {MIN_YEAR}-{MAX_YEAR}")
        )
    inputs = body.get("inputs")
    if inputs is not None and (
        not isinstance(inputs, dict) or not all(_valid_input_value(v) for v in inputs.values())
    ):
        issues.append(
            issue("inputs", "invalid_value", "inputs must be an object of finite numbers")
        )
    full: Plan | None = None
    if body.get("compare_to_plan") is not None and body.get("compare_to_plan_id") is not None:
        issues.append(
            issue(
                "compare_to_plan",
                "ambiguous",
                "give compare_to_plan or compare_to_plan_id, not both",
            )
        )
    elif body.get("compare_to_plan") is not None:
        try:
            full = Plan.model_validate(body["compare_to_plan"])
        except ValidationError as exc:
            issues += _validation_issues(exc, "compare_to_plan.")
    elif body.get("compare_to_plan_id") is not None:
        from acre.api.samples import load_samples

        sp = load_samples().plans.get(str(body["compare_to_plan_id"]))
        if sp is None or sp.plan is None:
            issues.append(
                issue("compare_to_plan_id", "unknown_plan", "unknown or unavailable sample plan")
            )
        else:
            full = sp.plan
    if issues or plan is None:
        return invalid(issues)
    result = evaluate_wheat_double_crop(
        plan, ctx, maturity_group=body.get("maturity_group"), year=year or default_planting_year(),
        inputs=inputs, full_season_plan=full,
    )  # fmt: skip
    if result["status"] == "invalid_input":
        return invalid([issue(i["field"], i["code"], i["message"]) for i in result["issues"]])
    # plan_version covers everything that changes the result: the effective inputs (including
    # the maturity group, however it was given) and the comparison plan.
    from acre.planner.wheat_path import _effective_inputs

    effective, _ = _effective_inputs(body.get("maturity_group"), inputs)
    versioned = {**effective, "_compare_to_plan": full.model_dump(mode="json") if full else None}
    return {"meta": response_meta(plan_version(plan, result["year"], versioned)), "result": result}


# --------------------------------------------------------------------------- generation (P1)

UNION_DEFAULT = {"latitude": 34.98, "longitude": -80.55}  # the NC demo point


def candidate_body(c: Any) -> dict[str, Any]:
    """Contract §8: the first season's ``Plan`` fields plus the candidate's own fields."""
    seasons = [s.model_dump(mode="json") for s in c.seasons]
    return {**seasons[0]["plan"], "candidate_id": c.candidate_id, "label": c.label,
            "crops": c.crops, "seasons": seasons, "origins": c.origins,
            "checks_summary": c.checks_summary, "matches_rotation": c.matches_rotation,
            "feasibility": c.feasibility}  # fmt: skip


@router.post("/plans/generate")
async def post_generate(request: Request) -> Any:
    """Body: ``{location?, field?, goals?, start_year?}`` (contract §8). Location defaults to the
    Union County demo point. Generated plans are ordinary ``Plan`` objects (one per season)."""
    from acre.planner.generator import generate_candidates
    from acre.planner.goals import FieldContext, Goals

    body, err = await read_object(request)
    if err is not None:
        return err
    issues: list[dict[str, str]] = []
    loc = body.get("location", UNION_DEFAULT)  # type: ignore[union-attr]
    point = None
    if isinstance(loc, dict):
        try:
            la, lo = float(loc.get("latitude")), float(loc.get("longitude"))  # type: ignore[arg-type]
            if -90 <= la <= 90 and -180 <= lo <= 180:
                point = {"latitude": la, "longitude": lo}
        except (TypeError, ValueError):
            point = None
    if point is None:
        issues.append(issue("location", "invalid_location",
                            "location needs latitude and longitude within range"))  # fmt: skip
    fc = goals = None
    try:
        fc = FieldContext.model_validate(body.get("field") or {})  # type: ignore[union-attr]
    except ValidationError as exc:
        issues += _validation_issues(exc, "field.")
    try:
        goals = Goals.model_validate(body.get("goals") or {})  # type: ignore[union-attr]
    except ValidationError as exc:
        issues += _validation_issues(exc, "goals.")
    start = body.get("start_year")  # type: ignore[union-attr]
    if start is not None and (isinstance(start, bool) or not isinstance(start, int)
                              or not MIN_YEAR <= start <= MAX_YEAR):  # fmt: skip
        issues.append(issue("start_year", "invalid_year",
                            f"start_year must be an integer in {MIN_YEAR}-{MAX_YEAR}"))  # fmt: skip
    if issues:
        return invalid(issues)
    from acre.geo.locate import describe

    if describe(point["latitude"], point["longitude"], allow_network=False).status == (  # type: ignore[index]
            "unsupported"):  # fmt: skip
        return {"meta": response_meta(), "status": "unsupported", "code": "unsupported_location",
                "reason": "over_water", "reason_text": "This point is over water.",
                "candidates": [], "generation_log": [], "gaps": []}  # fmt: skip
    res = generate_candidates(point, fc, goals, start_year=start)
    out = res.model_dump(mode="json", exclude={"candidates"})
    out["candidates"] = [candidate_body(c) for c in res.candidates]
    import hashlib
    import json

    pv = hashlib.sha256(json.dumps(
        {"goals": goals.model_dump(mode="json"), "start_year": res.start_year,  # type: ignore[union-attr]
         "catalog": res.catalog.get("catalog_version"),
         "history": fc.crop_history},  # type: ignore[union-attr]
        sort_keys=True).encode()).hexdigest()[:16]  # fmt: skip
    from acre.catalogs.regional import regional_catalog

    idx = regional_catalog(point["latitude"], point["longitude"])  # type: ignore[index]
    meta = response_meta(pv) if idx.in_nc else response_meta(pv, index=idx, weather=False)
    return {"meta": meta, **out}


# --------------------------------------------------------------------------- future plan (P3)


def _future_legs(body: dict[str, Any]) -> tuple[list[Plan], list[dict[str, str]],
                                                 list[dict[str, Any]], str, list[dict[str, str]]]:  # fmt: skip
    """``(legs, origins, sources, basis, issues)`` from ``candidate | plans | plan | plan_id |
    rotation_id``. Sample plans and rotations are demo presets (``assumed`` dates)."""
    from acre.planner.generator import _preset_rotations, _presets

    issues: list[dict[str, str]] = []
    if isinstance(body.get("candidate"), dict):
        seasons = body["candidate"].get("seasons")
        if not isinstance(seasons, list) or not seasons:
            return [], [], [], "grower", [issue("candidate.seasons", "required",
                                                "a candidate needs its seasons")]  # fmt: skip
        legs, origins, sources = [], [], []
        for n, s in enumerate(seasons):
            try:
                legs.append(Plan.model_validate((s or {}).get("plan")))
            except ValidationError as exc:
                issues += _validation_issues(exc, f"candidate.seasons[{n}].plan.")
                continue
            o = s.get("origins") if isinstance(s.get("origins"), dict) else {}
            from acre.catalogs.v3 import ORIGINS

            bad = sorted(k for k, v in o.items() if v not in ORIGINS)
            if bad:
                issues.append(issue(f"candidate.seasons[{n}].origins.{bad[0]}", "invalid_origin",
                                    f"origin must be one of {sorted(ORIGINS)}"))  # fmt: skip
                continue
            origins.append(dict(o))
            sources.append(s.get("sources") if isinstance(s.get("sources"), dict) else {})
        return legs, origins, sources, "grower", issues
    raw = body.get("plans")
    if raw is None and body.get("plan") is not None:
        raw = [body["plan"]]
    if raw is not None:
        if not isinstance(raw, list) or not raw:
            return [], [], [], "grower", [issue("plans", "invalid", "plans must be a list")]
        legs = []
        for n, p in enumerate(raw):
            try:
                legs.append(Plan.model_validate(p))
            except ValidationError as exc:
                issues += _validation_issues(exc, f"plans[{n}].")
        return legs, [{} for _ in legs], [{} for _ in legs], "grower", issues
    samples = {x["plan"]["plan_id"]: Plan.model_validate(x["plan"]) for x in _presets()}
    rid = body.get("rotation_id")
    pid = body.get("plan_id")
    rot = None
    if isinstance(rid, str):
        rot = next((legs for r, legs in _preset_rotations() if r == rid), None)
        if rot is None:
            return [], [], [], "assumed", [issue("rotation_id", "unknown_rotation",
                                                 f"unknown rotation '{rid}'")]  # fmt: skip
    elif isinstance(pid, str):
        if pid not in samples:
            return [], [], [], "assumed", [issue("plan_id", "unknown_plan",
                                                 f"unknown sample plan '{pid}'")]  # fmt: skip
        # a sample leg is laid out with its rotation's other leg, starting from this one
        rot = next((legs for _, legs in _preset_rotations() if pid in legs), (pid,))
        k = rot.index(pid)
        rot = (*rot[k:], *rot[:k])
    else:
        return [], [], [], "grower", [issue("plan", "required", "send candidate, plans, plan, "
                                            "plan_id or rotation_id")]  # fmt: skip
    legs = [samples[x] for x in rot]
    return legs, [{} for _ in legs], [{} for _ in legs], "assumed", []


def _priorities(raw: Any) -> dict[str, int]:
    from acre.planner.goals import PRIORITY_IDS

    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in PRIORITY_IDS and isinstance(v, int)
            and not isinstance(v, bool) and 0 <= v <= 3}  # fmt: skip


def _refresh(legs: list[Plan], priorities: dict[str, int], loc: Any) -> dict[str, Any]:
    """P2 (A's ``compare.recommend``) for this one plan: its indicators and historical
    vulnerabilities. Only the edited plan is rerun; ``unavailable`` when P2 or its weather is not
    there, never a guess."""
    try:
        from acre.compare import locations as places
        from acre.compare.recommend import Candidate, recommend
    except ImportError:
        return {"status": "unavailable", "reason": "recommendation_not_available",
                "reason_text": "The recommendation step (P2) is not installed here."}  # fmt: skip
    args: dict[str, Any] = {}
    if isinstance(loc, dict):
        args = {"latitude": float(loc["latitude"]), "longitude": float(loc["longitude"])}
    try:
        choice = places.choose(None, **args)
        if not choice.ok or choice.ctx is None:
            return {"status": "unavailable", "reason": choice.reason or "weather_unavailable",
                    "reason_text": "There is no stored weather for this place yet, so the plan's "
                    "history was not analysed."}  # fmt: skip
        res = recommend([Candidate("future_plan", list(legs), "This plan", "grower")], choice.ctx,
                        priorities or {})  # fmt: skip
    except Exception:  # noqa: BLE001 - the future plan never fails because P2 did
        return {"status": "unavailable", "reason": "recommendation_failed",
                "reason_text": "The recommendation step could not analyse this plan."}  # fmt: skip
    cards = [*res.get("shortlist", []), *res.get("not_comparable", []), *res.get("dominated", [])]
    card = cards[0] if cards else {}
    return {"status": res.get("status"), "result_id": res.get("result_id"),
            "method": res.get("method"), "indicators": card.get("indicators"),
            "historical_vulnerabilities": card.get("historical_vulnerabilities") or []}  # fmt: skip


@router.post("/plans/future")
async def post_future(request: Request) -> Any:
    """Body: ``{location?, candidate | plans | plan | plan_id | rotation_id, start_season,
    seasons, edits?, as_of?, inputs?}`` (contract §10)."""
    from datetime import date as _date

    from acre.catalogs.regional import regional_catalog
    from acre.planner.future import (
        MAX_SEASONS,
        Edit,
        FuturePlanError,
        apply_edits,
        build_future_plan,
        diff_future,
        public,
    )

    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    issues: list[dict[str, str]] = []
    index, state, loc_issues = _index_for(body)
    issues += loc_issues
    legs, origins, sources, basis, leg_issues = _future_legs(body)
    issues += leg_issues
    start = body.get("start_season", default_planting_year())
    if isinstance(start, str) and start.isdigit():
        start = int(start)
    if isinstance(start, bool) or not isinstance(start, int) or not MIN_YEAR <= start <= MAX_YEAR:
        issues.append(issue("start_season", "invalid_year", "start_season is a year like 2027"))
    n = body.get("seasons", len(legs) or 1)
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_SEASONS:
        issues.append(issue("seasons", "invalid_seasons",
                            f"seasons must be a whole number 1-{MAX_SEASONS}"))
    as_of = None
    if body.get("as_of") is not None:
        try:
            as_of = _date.fromisoformat(str(body["as_of"]))
        except ValueError:
            issues.append(issue("as_of", "invalid_date", "as_of must be YYYY-MM-DD"))
    edits: list[Edit] = []
    raw_edits = body.get("edits") or []
    if not isinstance(raw_edits, list):
        issues.append(issue("edits", "invalid", "edits must be a list"))
    else:
        for k, e in enumerate(raw_edits):
            try:
                edits.append(Edit.model_validate(e))
            except ValidationError as exc:
                issues += _validation_issues(exc, f"edits[{k}].")
    if issues:
        return invalid(issues)
    loc = body.get("location")
    calendars = None
    if isinstance(loc, dict):
        calendars = regional_catalog(float(loc["latitude"]), float(loc["longitude"]))
    legs = [map_plan_to_catalog(p, index) for p in legs]
    from acre.planner.future import check_chain, expand

    chain = check_chain(legs, n)
    if chain:
        return invalid([issue(i.field, i.code, i.message) for i in chain])
    legs, origins, sources, follow = expand(legs, origins, sources, n)
    common = {"start_season": start, "seasons": n, "sources": sources, "basis": basis,
              "calendars": calendars, "as_of": as_of, "inputs": body.get("inputs"),
              "follow": follow}  # fmt: skip
    priorities = _priorities(body.get("priorities"))
    try:
        before = build_future_plan(legs, index, origins=origins, **common)
        out = public(before)
        final_legs, prios = legs, {}
        if edits:
            years = [int(x["season"]) for x in before["seasons"]]
            new_legs, new_origins, e_issues, prios = apply_edits(legs, origins, edits, years)
            if e_issues:
                return invalid([issue(i.field, i.code, i.message) for i in e_issues])
            after = build_future_plan(new_legs, index, origins=new_origins, **common)
            out = public(after)
            out["diff"] = diff_future(before, after)
            final_legs = new_legs
        refresh = _refresh(final_legs, {**priorities, **prios}, loc)
        for s in out["seasons"]:
            s["historical_vulnerabilities"] = [
                v for v in refresh.get("historical_vulnerabilities", [])
                if v.get("plan_id") == s["plan"]["plan_id"]]  # fmt: skip
        if edits:
            out["recommendation_refresh"] = {
                **{k: v for k, v in refresh.items() if k != "historical_vulnerabilities"},
                "changed_plan_ids": sorted({p.plan_id for p, q in zip(legs, final_legs,
                                                                      strict=True) if p != q}),
                "priority_edits": prios}  # fmt: skip
    except FuturePlanError as exc:
        return invalid([issue(i.field, i.code, i.message) for i in exc.issues])
    regional = getattr(index, "in_nc", True) is False
    meta = response_meta(None, index=index, weather=False) if regional else response_meta()
    if state is not None:
        out["catalog"] = state
    out["dates_basis"] = basis
    return {"meta": meta, **out}
