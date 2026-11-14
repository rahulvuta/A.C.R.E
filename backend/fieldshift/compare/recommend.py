"""Explainable recommendation (P2): candidates -> indicators -> Pareto shortlist -> explanations.

Candidates come from B's ``generate_candidates()`` (P1). Until P1 lands, a stub offers the NC
preset rotations in NC and nothing elsewhere (``insufficient_data`` with a gap). A farmer-edited
candidate list can always be sent instead.

There is no score anywhere: the shortlist is the non-dominated set over the indicators named by
the farmer's priorities, ordered by rank positions only (``docs/indicators.md``).
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from fieldshift.compare import engine
from fieldshift.compare.context import Context
from fieldshift.compare.indicators import (
    SPECS,
    USABLE,
    Indicator,
    candidate_indicators,
    indicator_set,
)
from fieldshift.compare.models import PlanComparison
from fieldshift.compare.pareto import ParetoResult, pareto
from fieldshift.contracts import Plan, Status

log = logging.getLogger("fieldshift.recommend")

NOT_OPTIMAL = "Not universally optimal: depends on these priorities and this weather history."
PER_SEASON_FIELD = {
    "rain_on_bare_soil_mm": ("rain_outside_cover_mm", "high"),
    "heavy_rain_days_on_bare_soil": ("heavy_rain_days_outside_cover", "high"),
    "dry_pre_plant_frequency": ("spring_total_mm", "low"),
    "modeled_root_zone_wetness_at_planting": ("gwetroot_window_mean", "low"),
}


@dataclass
class Candidate:
    candidate_id: str
    plans: list[Plan]
    label: str | None = None
    origin: str = "grower"  # grower (farmer-edited) | assumed (preset) | generated (P1)
    sample_ids: list[str] = field(default_factory=list)  # sample plan ids (replay GET links)
    dates_assumed: bool = False
    origins: Any = None  # provenance of a generated candidate's dates and rules (P1)


# --------------------------------------------------------------------------- candidates (P1 stub)


def _matches_constraints(c: Candidate, constraints: dict[str, Any]) -> str | None:
    crops = {x for p in c.plans for x in (p.previous_crop_id, p.winter.crop_id, p.next_crop_id) if x}
    excluded = set(constraints.get("excluded_crops") or [])
    if crops & excluded:
        return f"uses excluded crop(s): {', '.join(sorted(crops & excluded))}"
    allowed = constraints.get("allowed_crops")
    if allowed is not None and not crops <= set(allowed):
        return f"uses crop(s) not allowed: {', '.join(sorted(crops - set(allowed)))}"
    must = set(constraints.get("must_include") or [])
    if must - crops:
        return f"does not include: {', '.join(sorted(must - crops))}"
    return None


def preset_candidates(ctx: Context, goals: dict[str, Any]) -> dict[str, Any]:
    """The P1 stub: the NC preset rotations (NC only), pruned by the simple crop constraints."""
    from fieldshift.api.samples import load_samples

    if not ctx.is_nc:
        return {"status": "insufficient_data", "candidates": [], "generation_log": [],
                "gaps": ["No candidate generator for this region yet (P1); send your own "
                         "candidates to compare them."]}  # fmt: skip
    samples = load_samples()
    constraints = goals.get("constraints") or {}
    out: list[Candidate] = []
    log: list[dict[str, Any]] = []
    for rot in samples.rotations.values():
        plans = [samples.plans[leg].plan for leg in rot.legs]
        if any(p is None for p in plans):
            continue
        c = Candidate(rot.rotation_id, plans, rot.label, "assumed", list(rot.legs),  # type: ignore[arg-type]
                      any(samples.plans[leg].meta.get("dates_assumed") for leg in rot.legs))
        why = _matches_constraints(c, constraints)
        if why:
            log.append({"constraint": "crops", "pruned": c.candidate_id, "reason_text": why})
            continue
        out.append(c)
    return {"status": "complete" if out else "insufficient_data", "candidates": out,
            "generation_log": log, "gaps": [] if out else ["Every preset breaks a constraint."]}  # fmt: skip


def generate(ctx: Context, location: dict[str, Any], field_ctx: dict[str, Any],
             goals: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    """B's ``generate_candidates`` (P1) when it exists, else the preset stub.

    A goals object P1 rejects is ``invalid_input`` (``issues``); a generator failure is
    ``unavailable`` with a reason, never a silent fallback to the presets.
    """
    try:
        from fieldshift.planner.generator import generate_candidates  # type: ignore[import-not-found]
        from fieldshift.planner.goals import FieldContext, Goals  # type: ignore[import-not-found]
    except ImportError:
        return preset_candidates(ctx, goals)
    from pydantic import ValidationError

    try:
        g = Goals.model_validate({k: goals[k] for k in ("priorities", "constraints", "preferences")
                                  if goals.get(k)})  # fmt: skip
        fc = FieldContext.model_validate({k: v for k, v in field_ctx.items()
                                          if k in FieldContext.model_fields and v is not None})  # fmt: skip
    except ValidationError as exc:
        return {"status": "invalid_input", "candidates": [], "generation_log": [], "gaps": [],
                "issues": [{"field": "goals." + ".".join(str(p) for p in e["loc"]),
                            "code": e["type"], "message": e["msg"]} for e in exc.errors()]}  # fmt: skip
    try:
        res = generate_candidates(location, fc, g)
    except Exception as exc:  # noqa: BLE001 - say so; never fall back silently
        log.error("candidate generator failed: %s", type(exc).__name__)
        return {"status": "unavailable", "reason": "candidate_generator_failed", "candidates": [],
                "generation_log": [], "gaps": ["The plan generator failed; send your own "
                                               "candidates to compare them."]}  # fmt: skip
    doc = res if isinstance(res, dict) else {
        "status": str(res.status), "candidates": list(res.candidates),
        "generation_log": [e.model_dump(mode="json") for e in res.generation_log],
        "gaps": list(res.gaps), "reason": res.reason, "reason_text": res.reason_text}  # fmt: skip
    cands = [_from_generated(raw, i) for i, raw in enumerate(doc.get("candidates", []))]
    return {**doc, "candidates": cands}


def _from_generated(raw: Any, i: int) -> Candidate:
    seasons = getattr(raw, "seasons", None)
    if seasons is not None and all(hasattr(s, "plan") for s in seasons):  # P1 models
        return Candidate(raw.candidate_id, [s.plan for s in seasons], raw.label, "generated",
                         origins={"candidate": list(raw.origins),
                                  "dates": [s.origins for s in seasons]})  # fmt: skip
    d = raw if isinstance(raw, dict) else raw.model_dump(mode="json")
    legs = d.get("plans") or [s.get("plan", s) for s in d.get("seasons") or []] or [d]
    plans = [Plan.model_validate({k: v for k, v in s.items() if k in Plan.model_fields})
             for s in legs]  # fmt: skip
    return Candidate(str(d.get("candidate_id") or f"c{i + 1}"), plans, d.get("label"), "generated",
                     origins=d.get("origins"))


# --------------------------------------------------------------------------- analysis


def _plan_key(p: Plan) -> str:
    return hashlib.sha256(json.dumps(p.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()


def analyze_candidates(cands: list[Candidate], ctx: Context) -> tuple[dict[str, list[PlanComparison]],
                                                                       Any]:  # fmt: skip
    """Every leg of every candidate against ONE frozen ThresholdSet (shared, never per candidate)."""
    all_plans = [p for c in cands for p in c.plans]
    ts = engine.threshold_set_for(ctx, [p.next_plant for p in all_plans])
    full = next((p for p in all_plans
                 if p.next_crop_id == "soybean" and p.winter.kind != "winter_grain"), None)  # fmt: skip
    if full is None and ctx.is_nc:
        from fieldshift.api.samples import load_samples

        sp = load_samples().plans.get("corn_soy__no_cover")
        full = sp.plan if sp else None
    cat = ctx.index.catalog
    base = (ctx.snapshot_hash, ctx.scope, ctx.cell_id, ts.threshold_set_id,
            f"{cat.version}:{cat.manifest.content_hash}", _plan_key(full) if full else None)
    legs: dict[str, list[PlanComparison]] = {}
    for c in cands:
        out = []
        for p in c.plans:
            k = (*base, _plan_key(p))
            if k not in _LEG_CACHE:
                if len(_LEG_CACHE) >= _LEG_CACHE_MAX:
                    _LEG_CACHE.pop(next(iter(_LEG_CACHE)))
                _LEG_CACHE[k] = engine.analyze_plan(p, ctx, ts, full_season_plan=full)[0]
            out.append(_LEG_CACHE[k])  # read-only here: recommendation never edits a leg
        legs[c.candidate_id] = out
    return legs, ts


#: One analysis per (snapshot, scope, thresholds, catalog, plan): generated candidates share legs.
_LEG_CACHE: dict[tuple[Any, ...], PlanComparison] = {}
_LEG_CACHE_MAX = 2048


# --------------------------------------------------------------------------- explanations


def _fmt(v: Any, unit: str) -> str:
    if isinstance(v, float):
        v = f"{v:.2f}" if v < 1 else f"{v:.1f}"
    return f"{v} {unit}"


def _audit_id(*parts: Any) -> str:
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12]


def _explain(cid: str, res: ParetoResult, inds: dict[str, dict[str, Indicator]],
             weights: dict[str, int], cands: dict[str, Candidate],
             legs: dict[str, list[PlanComparison]], ctx: Context,
             result_id: str, where: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    names = list(weights)
    short = res.shortlist
    pool = res.comparable  # explanations compare with every comparable candidate
    ranks = res.ranks_all[cid]
    worst = {n: max(res.ranks_all[o][n] for o in pool) for n in names}
    wins = [n for n in names if ranks[n] == 1 and len(pool) > 1]
    loses = [n for n in names if ranks[n] == worst[n] and worst[n] > 1]
    why = []
    for n in wins:
        s = SPECS[n]
        others = [inds[o][n].value for o in pool if o != cid]
        best = "Lowest" if s.direction == "lower_better" else "Highest"
        why.append({
            "indicator": n,
            "text": f"{best} {n.replace('_', ' ')} of the compared plans: "
                    f"{_fmt(inds[cid][n].value, s.unit)} (others: "
                    f"{', '.join(_fmt(v, s.unit) for v in others)}). {s.rationale}",
            "value": inds[cid][n].value, "source": s.source,
            "audit_id": _audit_id(result_id, cid, n),
        })  # fmt: skip
    if len(pool) == 1:
        why.append({"indicator": None, "text": "The only candidate not dominated on your "
                    "priorities' indicators.", "value": None, "source": None,
                    "audit_id": _audit_id(result_id, cid, "only")})  # fmt: skip
    trade_offs = []
    for o in [x for x in short if x != cid] + [x for x in res.dominated if x != cid]:
        worse = []
        for n in USABLE:
            a, b = inds[cid][n].value, inds[o][n].value
            if a is None or b is None:
                continue
            d = SPECS[n].direction
            if (a > b) if d == "lower_better" else (a < b):
                worse.append({"indicator": n, "value": a, "versus_value": b,
                              "in_priorities": n in weights})  # fmt: skip
        if worse:
            parts = [f"{w['indicator'].replace('_', ' ')} {_fmt(w['value'], SPECS[w['indicator']].unit)}"
                     f" vs {_fmt(w['versus_value'], SPECS[w['indicator']].unit)}"
                     + ("" if w["in_priorities"] else " (not in your priorities)")
                     for w in worse]  # fmt: skip
            trade_offs.append({"versus": o, "worse_on": worse,
                               "text": f"Compared with {o}, it is worse on: " + "; ".join(parts) + "."})  # fmt: skip
    return {
        "wins": wins, "loses": loses, "why": why, "trade_offs": trade_offs,
        "uncertainties": _uncertainties(cands[cid], legs[cid], ctx),
        "historical_vulnerabilities": _vulnerabilities(cands[cid], legs[cid], inds[cid],
                                                       res.ranks[cid], where),
    }


def _uncertainties(c: Candidate, legs: list[PlanComparison], ctx: Context) -> list[dict[str, Any]]:
    out = [
        {"text": "Weather is NASA POWER daily reanalysis for one ~0.5 x 0.625 degree grid cell, "
                 "not a field measurement; every field in the cell shares this series.",
         "origin": "nasa_modeled"},
        {"text": "Root-zone wetness is modeled (MERRA-2 GWETROOT), not observed.",
         "origin": "nasa_modeled"},
        {"text": "Living cover is planned; establishment is uncertain.", "origin": "assumed"},
    ]  # fmt: skip
    if c.dates_assumed:
        out.append({"text": "These are preset plans with assumed demo dates; edit them to your "
                    "own dates.", "origin": "assumed"})  # fmt: skip
    if not ctx.is_nc and not engine.has_rules(ctx):
        out.append({"text": "No regional guidance is loaded for this place, so no rule was "
                    "checked.", "origin": None})  # fmt: skip
    state_origin = (ctx.catalog_state or {}).get("origin")
    if state_origin in WEAK_ORIGINS:
        out.append({"text": WEAK_ORIGINS[state_origin].format(what="The regional guidance"),
                    "origin": state_origin})  # fmt: skip
    applied = {r.origin for pc in legs for r in pc.other_checks
               if r.origin and (r.flagged or r.status in (Status.MANUAL_CHECK, Status.COMPLETE))}
    for o in sorted(applied & set(WEAK_ORIGINS) - {state_origin}):
        out.append({"text": WEAK_ORIGINS[o].format(what="Some rules checked for this plan"),
                    "origin": o})  # fmt: skip
    for o in sorted(_origins(c.origins) & set(WEAK_ORIGINS)):
        out.append({"text": WEAK_ORIGINS[o].format(what="Some of this plan's dates or rules"),
                    "origin": o})  # fmt: skip
    for pc in legs:
        if pc.coverage is not None and len(pc.coverage.available_years) < 40:
            out.append({"text": f"Only {len(pc.coverage.available_years)} usable seasons for "
                        f"{pc.plan_id}'s windows at this cell.", "origin": "nasa_modeled"})  # fmt: skip
    return out


WEAK_ORIGINS = {
    "ai_suggested": "{what} came from AI research and was not confirmed on its source page.",
    "source_checked": "{what} came from AI research; the quote was found on the cited page, but "
                      "no person has verified it.",
    "dataset_estimate": "{what} comes from a gridded dataset estimate (for example SAGE crop "
                        "calendars), not local guidance.",
    "assumed": "{what} is assumed, not sourced.",
}


def _origins(obj: Any) -> set[str]:
    if isinstance(obj, str):
        return {obj}
    if isinstance(obj, dict):
        return set().union(*(_origins(v) for v in obj.values())) if obj else set()
    if isinstance(obj, list | tuple):
        return set().union(*(_origins(v) for v in obj)) if obj else set()
    return set()


def replay_location(ctx: Context, requested: dict[str, Any] | None = None) -> dict[str, Any]:
    """How a replay request names this recommendation's weather and rules: the NC place id, else
    the cell id (when the cell centre has the same NC/non-NC scope), else the requested point,
    rounded to the fewest decimals (2 or more) that keep its NC/non-NC scope."""
    from fieldshift.field.location import in_nc_bounds

    req = requested or {}
    if req.get("latitude") is not None and req.get("longitude") is not None:
        lat0, lon0 = float(req["latitude"]), float(req["longitude"])
        place0 = ctx.place
        if not (ctx.is_nc and place0 is not None and place0.id != place0.cell_id):
            cid0 = ctx.cell_id
            if cid0:
                c_lat, c_lon = (float(x) for x in cid0.removeprefix("cell_").split("_"))
                if in_nc_bounds(c_lat, c_lon) == ctx.is_nc:
                    return {"location": {"cell_id": cid0}}
            for d in (2, 3, 4, 5):
                lat, lon = round(lat0, d), round(lon0, d)
                if in_nc_bounds(lat, lon) == ctx.is_nc:
                    return {"location": {"latitude": lat, "longitude": lon}}
    place = ctx.place
    if ctx.is_nc and place is not None and place.id != place.cell_id:
        return {"location_id": place.id}
    cid = ctx.cell_id
    if cid:
        lat, lon = (float(x) for x in cid.removeprefix("cell_").split("_"))
        if in_nc_bounds(lat, lon) == ctx.is_nc:
            return {"location": {"cell_id": cid}}
        assert place is not None
        return {"location": {"latitude": round(place.latitude, 2),
                             "longitude": round(place.longitude, 2)}}  # fmt: skip
    return {}


def _vulnerabilities(c: Candidate, legs: list[PlanComparison], inds: dict[str, Indicator],
                     ranks: dict[str, int], where: dict[str, Any]) -> list[dict[str, Any]]:  # fmt: skip
    """Worst 3 past seasons on the candidate's weakest indicator that has a per-season series."""
    series = [n for n in PER_SEASON_FIELD if inds[n].value is not None]
    if not series:
        return []
    weakest = max(series, key=lambda n: (ranks.get(n, 0), n))
    attr, worst_is = PER_SEASON_FIELD[weakest]
    rows = []
    for i, pc in enumerate(legs):
        for s in pc.seasons:
            v = getattr(s, attr)
            if v is not None:
                rows.append((v, s.year, i, pc))
    rows.sort(key=lambda r: (-r[0] if worst_is == "high" else r[0], r[1]))
    out = []
    for v, year, _i, pc in rows[:3]:
        assert pc.plan is not None
        replay = {"method": "POST", "path": f"/v1/seasons/{year}/replay",
                  "body": {"plan": pc.plan.model_dump(mode="json"), **where}}  # fmt: skip
        out.append({"year": str(year), "indicator": weakest, "plan_id": pc.plan_id,
                    "value": v, "field": attr,
                    "text": f"{year}: {attr.replace('_', ' ')} {v} for {pc.plan_id}.",
                    "replay": replay})  # fmt: skip
    return out


# --------------------------------------------------------------------------- recommend


def recommend(cands: list[Candidate], ctx: Context, priorities: dict[str, int],
              soil: Any = None, requested: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    """``requested`` is the request's own location (a point or a cell), so replay links keep it."""
    legs, ts = analyze_candidates(cands, ctx)
    has_rules = engine.has_rules(ctx)
    inds = {c.candidate_id: candidate_indicators(legs[c.candidate_id], c.plans, ctx.index,
                                                 has_rules=has_rules) for c in cands}  # fmt: skip
    weights = indicator_set(priorities)
    asked = any(w for w in priorities.values())
    if not has_rules and not asked:
        # the default set (no priorities): rule flags are unknown everywhere here, so they are
        # left out of the default; a farmer who asks for weather_resilience keeps them, and an
        # unknown value then makes candidates not comparable rather than silently passing
        weights.pop("rule_flags", None)
    directions = {n: SPECS[n].direction for n in weights}
    vectors = {cid: {n: i.value for n, i in v.items()} for cid, v in inds.items()}
    res = pareto(vectors, directions, weights)
    by_id = {c.candidate_id: c for c in cands}
    cat = ctx.index.catalog
    result_id = engine.canonical_hash([
        ts.threshold_set_id, ctx.snapshot_hash, f"{cat.version}:{cat.manifest.content_hash}",
        weights, {c.candidate_id: [p.model_dump(mode="json") for p in c.plans] for c in cands},
    ])[:16]  # fmt: skip

    def card(cid: str) -> dict[str, Any]:
        c = by_id[cid]
        return {
            "candidate_id": cid, "label": c.label, "origin": c.origin,
            "plans": [p.model_dump(mode="json") for p in c.plans],
            "leg_status": [str(pc.status) for pc in legs[cid]],
            "indicators": {n: i.public(in_priorities=n in weights) for n, i in inds[cid].items()},
        }  # fmt: skip

    shortlist = []
    for cid in res.shortlist:
        item = card(cid)
        item["rank_positions"] = res.ranks[cid]
        item.update(_explain(cid, res, inds, weights, by_id, legs, ctx, result_id,
                             replay_location(ctx, requested)))  # fmt: skip
        shortlist.append(item)
    not_comparable = []
    for cid, miss in res.not_comparable.items():
        statuses = {str(pc.status) for pc in legs[cid]}
        st = "unavailable" if statuses <= {"unavailable", "unsupported"} else "partial"
        not_comparable.append({**card(cid), "status": st, "missing": miss})
    dominated = [{**card(cid), "dominated_by": by} for cid, by in res.dominated.items()]
    status = Status.COMPLETE if shortlist else Status.INSUFFICIENT_DATA
    if shortlist and not_comparable:
        status = Status.PARTIAL
    return {
        "status": str(status),
        "result_id": result_id,
        "method": {
            "shortlist": "pareto_non_dominated",
            "ordering": "weighted_rank_positions",
            "indicators_used": list(weights),
            "weights": weights,
            "ordering_text": "For each indicator the shortlisted plans are ranked (1 = best, ties "
                             "share a rank); they are listed by the sum of weight x rank "
                             "position. Raw values of different indicators are never combined.",
            "note": NOT_OPTIMAL,
            "definitions": "backend/docs/indicators.md",
        },  # fmt: skip
        "shortlist": shortlist,
        "not_comparable": not_comparable,
        "dominated": dominated,
        "thresholds": engine.thresholds_view(ts, ctx).model_dump(mode="json"),
        "context": {"soil": soil, "soil_note": "Soil context only; never turned into a benefit "
                    "number." if soil is not None else None},  # fmt: skip
        "hemisphere": ctx.hemisphere,
    }
