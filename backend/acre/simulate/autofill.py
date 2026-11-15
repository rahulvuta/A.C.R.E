"""Typical dates for one crop sequence, with the evidence for every suggestion (S6)."""

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
from acre.field.location import approximate_region, in_nc_bounds
from acre.field.regions import region_match
from acre.report.meta import response_meta
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

    def sage_date(crop: str, kind: str, field: str) -> str | None:
        cid = crop_ids.canonical(crop) or crop
        c = table.get("winter_rye" if cid == "cereal_rye" else cid)
        window = getattr(c, kind, None)
        value = window.typical if window is not None else None
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
    next_id = crop_ids.canonical(crops["next"]) or crops["next"]
    plant_rule = rule_for({"maize": ["fc_pw_03"], "soybean": ["sb_pw_01"]}.get(next_id, []))
    if plant_rule and plant_rule.window_start_mm_dd and plant_rule.window_end_mm_dd:
        plant = add("next_plant", _midpoint(plant_rule.window_start_mm_dd,
                                           plant_rule.window_end_mm_dd),
                    plant_rule.origin, {**_source(plant_rule), "method": "window_midpoint"})
    else:
        plant = sage_date(crops["next"], "plant", "next_plant")

    winter: dict[str, Any] = {"kind": "none"}
    if cover := crops.get("cover"):
        cover_id = crop_ids.canonical(cover) or cover
        seed_rule = rule_for({"cereal_rye": ["cr_pw_01"],
                              "crimson_clover": ["cc_pw_01"]}.get(cover_id, []))
        seed = None
        if harvest is not None:
            h = resolve_md(2001, harvest)
            if seed_rule and seed_rule.window_start_mm_dd and seed_rule.window_end_mm_dd:
                typical = _midpoint(seed_rule.window_start_mm_dd, seed_rule.window_end_mm_dd)
                # Compare in the season containing harvest. A midpoint before harvest is clamped
                # to harvest + 7, rather than moved into next year's seeding window.
                s = resolve_md(h.year, typical)
                if s < h - timedelta(days=180):
                    s = resolve_md(h.year + 1, typical)
                if s >= h + timedelta(days=7):
                    seed = add("winter.seed", s.strftime("%m-%d"), seed_rule.origin,
                               {**_source(seed_rule), "method": "window_midpoint"})
                else:
                    seed = add("winter.seed", (h + timedelta(days=7)).strftime("%m-%d"),
                               "calculation", {**_source(seed_rule),
                               "method": "max(window_midpoint, harvest + 7 days)",
                               "harvest_origin": "dataset_estimate", "spacing_origin": "assumed"})
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
        if plant is not None:
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
            "gaps": gaps, "note": "Typical calendar dates, not a forecast or planting advice; "
            "confirm them for this field. SAGE is a 0.5-degree gridded estimate."}
