"""10-year scenario runs by historical resampling (S1) with money (S2; ``money.py``).

* A scenario's rotation (1-4 plans, one per season) is cycled from ``start_season``.
* Each run draws ``years`` whole past seasons, with replacement, from the cell's 1981-2025
  record (numpy ``default_rng(seed)``). Every scenario sees the SAME draws in a run (common random
  numbers), so differences between scenarios come from the plans, not from the luck of the draw.
* The draw pool is the planting years in which every leg of every scenario is evaluable, so no
  scenario is ever filled with a blank season. Fewer than ``MIN_POOL`` years: insufficient_data.
* Per-year indicators reuse P2's definitions (``compare.indicators``). They describe the weather
  each plan would have met, not outcomes. Distributions are over runs: p10, median, p90.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

import numpy as np

from acre.compare import engine
from acre.compare.context import Context
from acre.compare.indicators import family_of
from acre.contracts import Plan
from acre.simulate import money as mon
from acre.simulate.seasons import LegSeasons, leg_seasons, plan_key

MIN_POOL = 15
NOTE = "Replays real past weather in new orders; not a forecast."
CRN_NOTE = ("Every scenario replays the same sequence of past seasons in each run, so differences "
            "come from the plans, not from the draw.")  # fmt: skip


@dataclass
class Scenario:
    scenario_id: str
    label: str | None
    rotation: list[Plan]
    is_baseline: bool = False


@dataclass
class Inputs:
    scenarios: list[Scenario]
    years: int = 10
    runs: int = 200
    seed: int = 7
    start_season: int = 2027
    area_ha: float | None = None
    equipment: list[str] = field(default_factory=list)
    overrides: dict[str, Any] = field(default_factory=dict)
    loss: dict[str, float | None] = field(default_factory=dict)
    location: dict[str, Any] = field(default_factory=dict)


def q(values: np.ndarray, digits: int = 1) -> dict[str, float | None]:
    if values.size == 0 or np.isnan(values).any():
        return {"p10": None, "median": None, "p90": None}
    p10, med, p90 = np.percentile(values, [10, 50, 90])
    r = (lambda v: int(round(float(v)))) if digits == 0 else (lambda v: round(float(v), digits))
    return {"p10": r(p10), "median": r(med), "p90": r(p90)}


def _pct(x: float) -> str:
    return f"{round(x * 100)}%"


@dataclass
class Draws:
    pool: list[int]
    index: np.ndarray  # [runs, years] -> position in ``pool``
    pos: np.ndarray  # pool year -> position in engine.YEARS


def draws(legs: list[LegSeasons], runs: int, years: int, seed: int) -> Draws:
    pool = sorted(set.intersection(*(leg.evaluable() for leg in legs))) if legs else []
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, max(1, len(pool)), size=(runs, years))
    pos = np.array([engine.YEARS.index(y) for y in pool], dtype=int)
    return Draws(pool, idx, pos)


@dataclass
class Matrices:
    rain: np.ndarray  # [runs, years]
    heavy: np.ndarray
    dry: np.ndarray
    cover: np.ndarray  # [years]
    ops: np.ndarray  # [years]
    seasons: np.ndarray  # [runs, years] past planting year replayed


def matrices(sc: Scenario, legs: dict[str, LegSeasons], d: Draws, years: int) -> Matrices:
    runs = d.index.shape[0]
    rain = np.empty((runs, years))
    heavy = np.empty((runs, years))
    dry = np.empty((runs, years))
    cover = np.empty(years)
    ops = np.empty(years)
    pool = np.array(d.pool)
    for t in range(years):
        leg = legs[plan_key(sc.rotation[t % len(sc.rotation)])]
        ix = d.pos[d.index[:, t]]
        rain[:, t] = leg.rain_bare_mm[ix]
        heavy[:, t] = leg.heavy_bare_days[ix]
        dry[:, t] = leg.dry[ix]
        cover[t] = leg.living_cover_days
        ops[t] = leg.operations
    return Matrices(rain, heavy, dry, cover, ops, pool[d.index])


def _families(sc: Scenario, ctx: Context, years: int) -> tuple[int | None, dict[str, str | None]]:
    crops = [c for p in sc.rotation[:years] for c in (p.previous_crop_id, p.winter.crop_id,
                                              p.next_crop_id) if c]  # fmt: skip
    fams = {c: family_of(c, ctx.index) for c in dict.fromkeys(crops)}
    if any(f is None for f in fams.values()):
        return None, fams
    return len(set(fams.values())), fams


def _events(m: Matrices, years: int) -> list[dict[str, Any]]:
    out = []
    dry_n = m.dry.sum(axis=1)
    heavy_years = (m.heavy > 0).sum(axis=1)
    if years >= 3:
        p = float((dry_n >= 3).mean())
        out.append({"event": f"dry_springs_ge_3_in_{years}y", "probability": round(p, 3),
                    "text": f"3 or more dry pre-planting windows in {years} years in {_pct(p)} "
                            "of replays"})  # fmt: skip
        p = float((heavy_years >= 3).mean())
        out.append({"event": f"heavy_rain_on_bare_soil_years_ge_3_in_{years}y",
                    "probability": round(p, 3),
                    "text": f"3 or more years with heavy rain on bare soil in {years} years in "
                            f"{_pct(p)} of replays"})  # fmt: skip
    if years >= 2:
        b2b = ((m.dry[:, 1:] > 0) & (m.dry[:, :-1] > 0)).any(axis=1)
        p = float(b2b.mean())
        out.append({"event": "back_to_back_dry_springs", "probability": round(p, 3),
                    "text": f"Two dry pre-planting windows in a row in {_pct(p)} of replays"})
    return out


def _timeline(sc: Scenario, inp: Inputs) -> list[dict[str, Any]]:
    out = []
    for t in range(inp.years):
        p = sc.rotation[t % len(sc.rotation)]
        seq = [c for c in (p.previous_crop_id, p.winter.crop_id, p.next_crop_id) if c]
        out.append({"year": inp.start_season + t, "season": str(inp.start_season + t),
                    "crop_sequence": seq, "plan_id": p.plan_id, "winter_kind": p.winter.kind,
                    "next_plant": p.next_plant, "prev_harvest": p.prev_harvest})  # fmt: skip
    return out


# --------------------------------------------------------------------------- money (S2)


def _money(sc: Scenario, m: Matrices, inp: Inputs, crops: dict[str, mon.CropMoney]
           ) -> dict[str, Any]:  # fmt: skip
    gaps: list[dict[str, str]] = []
    if not inp.area_ha:
        gaps.append({"field": "area", "reason": "no_area",
                     "text": "Give the field's area (or draw it) to see money results."})  # fmt: skip
        return {"money_status": "unavailable", "money_gaps": gaps, "yearly": None, "totals": None}
    need_rev: list[list[str]] = []
    need_cost: list[list[str]] = []
    for t in range(inp.years):
        p = sc.rotation[t % len(sc.rotation)]
        rev = [p.next_crop_id] + ([p.winter.crop_id] if p.winter.kind == "winter_grain"
                                  and p.winter.crop_id else [])  # fmt: skip
        cost = rev + ([p.winter.crop_id] if p.winter.kind == "cover" and p.winter.crop_id else [])
        need_rev.append(rev)
        need_cost.append(cost)
    used = sorted({c for cs in need_cost for c in cs})
    for c in used:
        cm = crops[c]
        is_rev = any(c in r for r in need_rev)
        if (is_rev and not cm.revenue_ok) or cm.cost_per_area is None:
            gaps += [g for g in cm.gaps if not (not is_rev and g["field"] in ("price", "yield"))]
    currencies = {crops[c].currency for c in used if crops[c].currency}
    if len(currencies) > 1:
        gaps.append({"field": "currency", "reason": "currency_mismatch",
                     "text": "Crops use different currencies; money is not added across them."})
    if gaps:
        some = any(crops[c].status != "unavailable" for c in used)
        return {"money_status": "partial" if some else "unavailable", "money_gaps": gaps,
                "yearly": None, "totals": None}  # fmt: skip
    cur = next(iter(currencies), None)
    dry_l = (inp.loss.get("dry_spring_pct") or 0) / 100.0
    heavy_l = (inp.loss.get("heavy_rain_pct") or 0) / 100.0
    runs = m.rain.shape[0]

    def run_with(price_of: dict[str, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray, list]:
        rev = np.zeros((runs, inp.years))
        cost = np.zeros((runs, inp.years))
        flags: list[list[str]] = []
        for t in range(inp.years):
            p = sc.rotation[t % len(sc.rotation)]
            used_t: list[str] = []
            for c in need_rev[t]:
                cm = crops[c]
                base = cm.yield_per_area * price_of[c] * mon.area_in(cm.area_unit, inp.area_ha)  # type: ignore[operator, arg-type]
                factor = np.ones(runs)
                if c == p.next_crop_id:  # the crop planted after the window the events describe
                    if inp.loss.get("dry_spring_pct") is not None and (m.dry[:, t] > 0).any():
                        factor *= 1 - dry_l * (m.dry[:, t] > 0)
                        used_t.append("dry_spring_pct")
                    if inp.loss.get("heavy_rain_pct") is not None and (m.heavy[:, t] > 0).any():
                        factor *= 1 - heavy_l * (m.heavy[:, t] > 0)
                        used_t.append("heavy_rain_pct")
                rev[:, t] += base * factor
            for c in need_cost[t]:
                cm = crops[c]
                cost[:, t] += cm.cost_per_area * mon.area_in(cm.area_unit, inp.area_ha)  # type: ignore[operator, arg-type]
            flags.append(sorted(set(used_t)))
        return rev, cost, rev - cost, flags

    typical = {c: crops[c].price for c in used if crops[c].price is not None}
    rev, cost, margin, flags = run_with(typical)  # type: ignore[arg-type]

    def money(values: np.ndarray, assumption: list[str] | None = None) -> dict[str, Any]:
        out = {**q(values, 0), "currency": cur, "origin": "calculation"}
        if assumption is not None:
            out["includes_assumption"] = "+".join(assumption) if assumption else None
        return out

    yearly = [{"revenue": money(rev[:, t], flags[t]), "costs": money(cost[:, t]),
               "margin": money(margin[:, t], flags[t])} for t in range(inp.years)]  # fmt: skip
    all_flags = sorted({f for fl in flags for f in fl})
    totals: dict[str, Any] = {"margin_10y": money(margin.sum(axis=1), all_flags)}
    rev_crops = sorted({c for r in need_rev for c in r})
    if all(crops[c].price_low is not None and crops[c].price_high is not None for c in rev_crops):
        cases = {}
        for case in ("low", "high"):
            prices = {**typical, **{c: getattr(crops[c], f"price_{case}") for c in rev_crops}}
            cases[case] = q(run_with(prices)[2].sum(axis=1), 0)["median"]
        cases["typical"] = totals["margin_10y"]["median"]
        totals["margin_10y_price_cases"] = {**cases, "currency": cur, "origin": "calculation",
                                            "text": "Median 10-year margin at the low, typical "
                                                    "and high price of each source's range."}  # fmt: skip
    if not all_flags:
        totals["weather_link"] = ("none: money does not change with weather unless you enter a "
                                  "loss assumption (e.g. % of yield lost in a dry spring)")  # fmt: skip
    else:
        totals["weather_link"] = ("assumed (your estimate): your loss assumption is applied only "
                                  "in replayed years with that event")  # fmt: skip
    return {"money_status": "complete", "money_gaps": [], "yearly": yearly, "totals": totals}


# --------------------------------------------------------------------------- readings (S5 data)


READING_VARS = {"soil_moisture_pct": "gwettop", "soil_moisture_vwc": "gwettop",
                "rainfall_mm": "precip_mm", "soil_temp_c": "tmean_c"}  # fmt: skip
READING_NOTES = {
    "gwettop": "NASA modeled surface soil wetness (0-1, top ~5 cm). A different measure from a "
               "probe reading: shown for context, never mixed.",
    "precip_mm": "NASA POWER daily precipitation for the ~50 km cell.",
    "tmean_c": "NASA POWER daily mean AIR temperature at 2 m; there is no modeled soil "
               "temperature here.",
}  # fmt: skip


def readings_context(readings: list[dict[str, Any]], ctx: Context) -> list[dict[str, Any]]:
    """Each farmer reading next to NASA's modeled value for the same day (when the record covers
    it) and the cell's 1981-2025 spread for that calendar day. Never combined with the run."""
    frame = ctx.series.frame
    out = []
    for r in readings:
        var = READING_VARS.get(r.get("kind", ""))
        item = {**r, "origin": "grower", "modeled_same_day": None, "modeled_typical_for_date": None}
        try:
            d = date.fromisoformat(str(r.get("date")))
        except ValueError:
            d = None
        if var is not None and d is not None and var in frame.columns:
            same = None
            if ctx.series.first_date <= d <= ctx.series.last_date:
                v = frame[var].get(np.datetime64(d, "D"))
                if v is not None and v == v:
                    same = {var: round(float(v), 3), "origin": "nasa_modeled"}
            item["modeled_same_day"] = same
            if same is None:
                item["modeled_same_day_reason"] = (
                    f"outside the weather record ({ctx.series.first_date}..{ctx.series.last_date})")
            idx = frame.index
            vals = frame.loc[(idx.month == d.month) & (idx.day == d.day), var].dropna().to_numpy()
            if vals.size:
                item["modeled_typical_for_date"] = {
                    "variable": var, **q(vals, 3), "years": f"{idx.min().year}-{idx.max().year}",
                    "origin": "nasa_modeled", "note": READING_NOTES[var]}  # fmt: skip
        out.append(item)
    return out


# --------------------------------------------------------------------------- whole simulation


def simulate(ctx: Context, inp: Inputs) -> dict[str, Any]:
    plans = {plan_key(p): p for sc in inp.scenarios for p in sc.rotation[:inp.years]}
    ts = engine.threshold_set_for(ctx, [p.next_plant for p in plans.values()])
    legs = {k: leg_seasons(p, ctx, ts) for k, p in plans.items()}
    d = draws(list(legs.values()), inp.runs, inp.years, inp.seed)
    method = {"weather": "historical_resampling", "runs": inp.runs, "seed": inp.seed,
              "years": inp.years, "start_season": str(inp.start_season),
              "source_years": f"{engine.YEARS[0]}-{engine.YEARS[-1]}",
              "pool_years": len(d.pool), "note": NOTE, "draws": CRN_NOTE,
              "threshold_set_id": ts.threshold_set_id,
              "resolution": "One NASA POWER cell (~0.5 x 0.625 degrees): fields in one cell share "
                            "one weather series."}  # fmt: skip
    if len(d.pool) < MIN_POOL:
        return {"status": "insufficient_data", "method": method,
                "reason": "insufficient_seasons",
                "reason_text": f"Only {len(d.pool)} past seasons can be evaluated for every plan "
                               f"here (at least {MIN_POOL} are needed).",
                "scenarios": []}  # fmt: skip
    crops = sorted({c for sc in inp.scenarios for p in sc.rotation[:inp.years]
                    for c in (p.next_crop_id, p.winter.crop_id) if c})  # fmt: skip
    cm, money_source = mon.crop_money(inp.location, crops, inp.area_ha, inp.equipment,
                                      inp.overrides)  # fmt: skip
    out = []
    mats: dict[str, Matrices] = {}
    for sc in inp.scenarios:
        m = matrices(sc, legs, d, inp.years)
        mats[sc.scenario_id] = m
        fam_n, fams = _families(sc, ctx, inp.years)
        money = _money(sc, m, inp, cm)
        yearly = []
        for t in range(inp.years):
            row = {"year": inp.start_season + t,
                   "indicators": {
                       "rain_on_bare_soil_mm": {**q(m.rain[:, t]), "unit": "mm",
                                                "origin": "calculation"},
                       "heavy_rain_days_on_bare_soil": {**q(m.heavy[:, t], 0), "unit": "days",
                                                        "origin": "calculation"},
                       "living_cover_days": {"median": int(m.cover[t]), "unit": "days",
                                             "origin": "calculation", "planned": True},
                       "dry_pre_plant": {"probability": round(float(m.dry[:, t].mean()), 3),
                                         "origin": "calculation"},
                       "operations": {"value": int(m.ops[t]), "unit": "operations",
                                      "origin": "calculation"}},
                   "money": money["yearly"][t] if money["yearly"] else None}  # fmt: skip
            yearly.append(row)
        stress = m.dry.sum(axis=1) + (m.heavy > 0).sum(axis=1)
        totals: dict[str, Any] = {
            "living_cover_days_per_year": {"median": round(float(m.cover.mean()), 1),
                                           "unit": "days", "origin": "calculation"},
            "rain_on_bare_soil_mm_per_year": {**q(m.rain.mean(axis=1)), "unit": "mm",
                                              "origin": "calculation"},
            "heavy_rain_days_on_bare_soil_per_year": {**q(m.heavy.mean(axis=1), 2),
                                                      "unit": "days", "origin": "calculation"},
            "dry_springs": {**q(m.dry.sum(axis=1), 0), "mean": round(float(m.dry.sum(1).mean()), 2),
                            "unit": f"in {inp.years} years", "origin": "calculation"},
            "stress_events": {**q(stress, 0), "mean": round(float(stress.mean()), 2),
                              "unit": f"in {inp.years} years", "origin": "calculation",
                              "definition": "dry pre-planting windows plus years with heavy rain "
                                            "on bare soil"},
            "crop_families": fam_n,
            "crop_families_detail": fams,
            "operations_per_year": round(float(m.ops.mean()), 2),
            **(money["totals"] or {}),
        }  # fmt: skip
        out.append({"scenario_id": sc.scenario_id, "label": sc.label,
                    "is_baseline": sc.is_baseline, "status": "complete",
                    "timeline": _timeline(sc, inp), "yearly": yearly, "totals": totals,
                    "events": _events(m, inp.years), "money_status": money["money_status"],
                    "money_gaps": money["money_gaps"],
                    "replayed_seasons_sample": [int(y) for y in m.seasons[0]]})  # fmt: skip
    return {"status": "complete", "method": {**method, "money_source": money_source},
            "scenarios": out, "_matrices": mats,
            "crop_money": {c: v.public() for c, v in cm.items()}}  # fmt: skip
