"""Typical dates for one crop sequence, with the evidence for every suggestion (S6).

A date comes from the verified catalog, else the SAGE dataset, else a researched calendar of the
library for the location's region (card: calendar research; the window's middle, labelled with the
calendar's own origin, ``source_checked`` or ``ai_suggested``). Verified and SAGE dates always win.
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any

from acre.catalogs import crop_ids, sage
from acre.catalogs.models import CropRule
from acre.compare import engine
from acre.compare.regional import catalog_for
from acre.contracts import InvalidPlanError, Plan
from acre.croplib import library
from acre.economics.estimate import region_chain
from acre.field.location import approximate_region, in_nc_bounds
from acre.field.regions import region_match
from acre.report.meta import response_meta
from acre.research import client
from acre.seasons.dates import resolve_md

ASSUMED_SOURCE = {"title": "A.C.R.E default spacing (assumed, not sourced)", "url": None}


def _source(rule: CropRule) -> dict[str, Any]:
    return {"title": rule.source_title, "url": rule.source_url,
            "locator": rule.source_locator, "rule_id": rule.rule_id,
            "applies_when": rule.applies_when, "production_system": rule.production_system}


def _midpoint(start: str, end: str) -> str:
    a, b = resolve_md(2001, start), resolve_md(2001, end)
    if b < a:
        b = resolve_md(2002, end)
    return (a + (b - a) // 2).strftime("%m-%d")


def _chain(latitude: float, longitude: float) -> tuple[list[str], str | None]:
    """The point's region keys (most specific first), as the economics estimate derives them."""
    try:
        return region_chain({"latitude": latitude, "longitude": longitude})
    except Exception:  # noqa: BLE001 - a missing region only disables the researched fallback
        return [], None


def _research_rows(crops: dict[str, str], chain: list[str], missing: dict[str, bool]
                   ) -> list[dict[str, Any]]:  # fmt: skip
    """Per requested crop: when its calendar was last researched here, and whether no verified,
    SAGE or researched date covers its role (so a lookup would help)."""
    rows = []
    for role in ("previous", "cover", "next"):
        if role not in crops:
            continue
        cid = crop_ids.canonical(crops[role]) or crops[role]
        done = library.research_status("calendars", cid, chain[0]) if chain else None
        rows.append({"crop_id": crops[role], "role": role,
                     "researched_at": done["researched_at"] if done else None,
                     "missing": bool(missing.get(role, True))})  # fmt: skip
    return rows


def autofill(latitude: float, longitude: float, crops: dict[str, str]) -> dict[str, Any]:
    """No weather fetch or AI call. Missing calendars stay blank and prevent a complete plan."""
    nc = in_nc_bounds(latitude, longitude)
    index, _ = catalog_for(latitude, longitude, in_nc=nc)
    region = approximate_region(latitude, longitude) if nc else None
    dates: list[dict[str, Any]] = []
    gaps: list[dict[str, str]] = []
    try:
        calendars, _ = sage.calendars_at(latitude, longitude)
    except sage.SageUnavailable:
        calendars = []
    table = {c.crop_id: c for c in calendars}
    chain, _country = _chain(latitude, longitude)
    missing: dict[str, bool] = {}

    def gap(field: str, reason: str, text: str) -> None:
        gaps.append({"field": field, "reason": reason, "text": text})

    def add(field: str, value: str | None, origin: str | None,
            source: dict[str, Any] | None) -> str | None:
        dates.append({"field": field, "value": value, "origin": origin, "source": source,
                      "status": "complete" if value is not None else "unavailable"})
        return value

    def rule_for(ids: list[str]) -> CropRule | None:
        if not nc:
            return None
        for rid in ids:
            r = index.rule(rid)
            if (r is not None and r.origin == "verified_source" and r.source_url
                    and region_match(r.region, region)[0] == "match"):
                return r
        return None

    def researched(crop: str, kind: str) -> tuple[str, str, str, dict[str, Any]] | None:
        """A researched window (``plant`` or ``harvest``; for a cover crop seeding or
        termination) of the library for the region chain: start, end, origin, source."""
        cal = library.researched_calendar(crop_ids.canonical(crop) or crop, chain)
        w = (cal or {}).get(kind)
        if cal is None or not w or not w.get("start") or not w.get("end"):
            return None
        return w["start"], w["end"], cal["origin"], {
            **(cal["source"] or {}), "region_key": cal["region_key"], "researched": True,
            "method": "window_midpoint"}  # fmt: skip

    def sage_date(crop: str, kind: str, field: str) -> str | None:
        cid = crop_ids.canonical(crop) or crop
        c = table.get("winter_rye" if cid == "cereal_rye" else cid)
        window = getattr(c, kind, None)
        value = window.typical if window is not None else None
        if value is None and (r := researched(crop, kind)) is not None:
            if r[2] != "source_checked":
                gap(field, "unverified_calendar", f"This {kind} date comes from AI research of "
                    f"{r[3]['region_key']} and is not verified; confirm it for this field.")
            return add(field, _midpoint(r[0], r[1]), r[2], r[3])
        if value is None:
            gap(field, "no_calendar", f"No typical {kind} date for {crop} in this SAGE cell; "
                "enter the field's own date.")
            return add(field, None, None, None)
        if c.extrapolated:
            gap(field, "extrapolated_calendar", "SAGE extrapolated this calendar from neighbouring "
                "reports; confirm the date for this field.")
        return add(field, value, "dataset_estimate", {**sage.source(), "sage_cell": c.cell,
                   "resolution_deg": 0.5, "extrapolated": c.extrapolated})

    harvest = sage_date(crops["previous"], "harvest", "prev_harvest")
    missing["previous"] = harvest is None
    next_id = crop_ids.canonical(crops["next"]) or crops["next"]
    plant_rule = rule_for({"maize": ["fc_pw_03"], "soybean": ["sb_pw_01"]}.get(next_id, []))
    if plant_rule and plant_rule.window_start_mm_dd and plant_rule.window_end_mm_dd:
        plant = add("next_plant", _midpoint(plant_rule.window_start_mm_dd,
                                           plant_rule.window_end_mm_dd),
                    plant_rule.origin, {**_source(plant_rule), "method": "window_midpoint"})
    else:
        plant = sage_date(crops["next"], "plant", "next_plant")
    missing["next"] = plant is None

    winter: dict[str, Any] = {"kind": "none"}
    if cover := crops.get("cover"):
        cover_id = crop_ids.canonical(cover) or cover
        seed_rule = rule_for({"cereal_rye": ["cr_pw_01"],
                              "crimson_clover": ["cc_pw_01"]}.get(cover_id, []))
        seed = None
        has_rule = bool(seed_rule and seed_rule.window_start_mm_dd and seed_rule.window_end_mm_dd)
        seed_res = None if has_rule else researched(cover, "plant")
        term_res = researched(cover, "harvest")
        if has_rule:  # a verified window: (start, end, origin, source)
            seed_win = (seed_rule.window_start_mm_dd, seed_rule.window_end_mm_dd,  # type: ignore[union-attr]
                        seed_rule.origin, {**_source(seed_rule), "method": "window_midpoint"})  # type: ignore[union-attr]
        else:
            seed_win = seed_res
        if harvest is not None:
            h = resolve_md(2001, harvest)
            if seed_win:
                typical = _midpoint(seed_win[0], seed_win[1])
                # Compare in the season containing harvest. A midpoint before harvest is clamped
                # to harvest + 7, rather than moved into next year's seeding window.
                s = resolve_md(h.year, typical)
                if s < h - timedelta(days=180):
                    s = resolve_md(h.year + 1, typical)
                if s >= h + timedelta(days=7):
                    seed = add("winter.seed", s.strftime("%m-%d"), seed_win[2], seed_win[3])
                else:
                    seed = add("winter.seed", (h + timedelta(days=7)).strftime("%m-%d"),
                               "calculation", {**seed_win[3],
                               "method": "max(window_midpoint, harvest + 7 days)",
                               "harvest_origin": next(d["origin"] for d in dates
                                                      if d["field"] == "prev_harvest"),
                               "spacing_origin": "assumed"})
                    gap("winter.seed", "harvest_spacing", "Seeding was moved to seven days after "
                        "the estimated harvest; confirm it against the published seeding window.")
            else:
                seed = add("winter.seed", (h + timedelta(days=7)).strftime("%m-%d"), "assumed",
                           {**ASSUMED_SOURCE, "method": "harvest + 7 days"})
        else:
            add("winter.seed", None, None, None)
            gap("winter.seed", "missing_harvest", "A harvest date is needed before cover seeding "
                "can be suggested.")

        term_rule = rule_for(["cr_tt_01" if next_id == "maize" else "cr_tt_03"]
                             if cover_id == "cereal_rye" and next_id in ("maize", "soybean")
                             else [])
        n = (term_rule.value_max if next_id == "maize" else term_rule.value_min) \
            if term_rule else None
        spacing = int(n) if n is not None else 14
        terminate = None
        if term_res is not None and term_rule is None:  # a researched termination window
            terminate = add("winter.terminate", _midpoint(term_res[0], term_res[1]), term_res[2],
                            term_res[3])
            if term_res[2] != "source_checked":
                gap("winter.terminate", "unverified_calendar", "This termination date comes from "
                    "AI research and is not verified; confirm it for this field.")
        elif plant is not None:
            terminate = add("winter.terminate",
                            (resolve_md(2001, plant) - timedelta(days=spacing)).strftime("%m-%d"),
                            "calculation" if term_rule else "assumed",
                            {**(_source(term_rule) if term_rule else ASSUMED_SOURCE),
                             "method": f"next planting minus {spacing} days",
                             "spacing_origin": term_rule.origin if term_rule else "assumed"})
        else:
            add("winter.terminate", None, None, None)
            gap("winter.terminate", "missing_planting", "A planting date is needed before cover "
                "termination can be suggested.")
        winter = {"kind": "cover", "crop_id": cover, "seed": seed, "terminate": terminate}
        missing["cover"] = not (has_rule or seed_res or term_res)

    plan = None
    if harvest is not None and plant is not None and all(d["value"] is not None for d in dates):
        pid = "autofill_" + hashlib.sha256(json.dumps(crops, sort_keys=True).encode()).hexdigest()[:12]
        candidate = Plan(plan_id=pid, label="Typical dates; confirm for this field",
                         previous_crop_id=crops["previous"], prev_harvest=harvest,
                         next_crop_id=crops["next"], next_plant=plant, winter=winter, region=region)
        try:
            engine.build_calendar(candidate, engine.REFERENCE_YEAR)
        except InvalidPlanError as exc:
            for i in exc.issues:
                gap(i.field, i.code, i.message)
        else:
            plan = candidate.model_dump(mode="json")
    return {"meta": response_meta(index=index, weather=False),
            "status": "partial" if gaps else "complete", "plan": plan, "dates": dates,
            "gaps": gaps, "research": {"available": client.configured(),
                                       "region_key": chain[0] if chain else None},
            "calendar_research": _research_rows(crops, chain, missing), "note": "Typical calendar dates, not a forecast or planting advice; "
            "confirm them for this field. SAGE is a 0.5-degree gridded estimate."}
