"""10-year scenario runs by historical resampling (S1) with money (S2; ``money.py``).

* A scenario's rotation (1-10 plans, one per season) is cycled from ``start_season``.
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
from datetime import date, timedelta
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


_DAY = timedelta(days=1)


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
    return [{**event, "origin": "calculation"} for event in out]


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
        return {"money_status": "unavailable", "money_gaps": gaps, "yearly": None, "totals": None,
                "monthly": None}  # fmt: skip
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
                "yearly": None, "totals": None, "monthly": None}  # fmt: skip
    cur = next(iter(currencies), None)
    dry_l = (inp.loss.get("dry_spring_pct") or 0) / 100.0
    heavy_l = (inp.loss.get("heavy_rain_pct") or 0) / 100.0
    runs = m.rain.shape[0]

    # (season, crop, "revenue" | "cost", per-run amounts) of the last run_with call
    parts: list[tuple[int, str, str, np.ndarray]] = []

    def run_with(price_of: dict[str, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray, list]:
        rev = np.zeros((runs, inp.years))
        cost = np.zeros((runs, inp.years))
        flags: list[list[str]] = []
        parts.clear()
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
                parts.append((t, c, "revenue", base * factor))
            for c in need_cost[t]:
                cm = crops[c]
                c_cost = cm.cost_per_area * mon.area_in(cm.area_unit, inp.area_ha)  # type: ignore[operator, arg-type]
                cost[:, t] += c_cost
                parts.append((t, c, "cost", np.full(runs, float(c_cost))))
            flags.append(sorted(set(used_t)))
        return rev, cost, rev - cost, flags

    typical = {c: crops[c].price for c in used if crops[c].price is not None}
    rev, cost, margin, flags = run_with(typical)  # type: ignore[arg-type]
    typical_parts = list(parts)

    def money(values: np.ndarray, assumption: list[str] | None = None) -> dict[str, Any]:
        out = {**q(values, 0), "currency": cur, "origin": "calculation"}
        if assumption is not None:
            out["includes_assumption"] = "+".join(assumption) if assumption else None
        return out

    yearly = [{"revenue": money(rev[:, t], flags[t]), "costs": money(cost[:, t]),
               "margin": money(margin[:, t], flags[t])} for t in range(inp.years)]  # fmt: skip
    all_flags = sorted({f for fl in flags for f in fl})
    totals: dict[str, Any] = {"margin_10y": money(margin.sum(axis=1), all_flags),
                              # money spent and earned over the whole horizon, per run
                              "costs_total": money(cost.sum(axis=1)),
                              "revenue_total": money(rev.sum(axis=1), all_flags)}  # fmt: skip
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
    monthly = _monthly(sc, m, inp, typical_parts, cur, all_flags)
    return {"money_status": "complete", "money_gaps": [], "yearly": yearly, "totals": totals,
            "monthly": monthly}  # fmt: skip


# --------------------------------------------------------------------------- month by month (cash calendar)

TIMING_TEXT = ("Costs are counted in the month each crop is planted or seeded, and sales in its "
               "harvest month. Your real timing of input purchases and grain sales may differ.")


def _on(md: str, year: int) -> date:
    m, d = int(md[:2]), int(md[3:5])
    return date(year, m, min(d, 28) if m == 2 else d)


def _after(md: str, ref: date) -> date:
    """First date on this month-day strictly after ``ref``."""
    d = _on(md, ref.year)
    return d if d > ref else _on(md, ref.year + 1)


def _before(md: str, ref: date) -> date:
    """Last date on this month-day strictly before ``ref``."""
    d = _on(md, ref.year)
    return d if d < ref else _on(md, ref.year - 1)


def _season_dates(sc: Scenario, t: int, start: int) -> dict[str, Any]:
    """Calendar dates of season ``t``: planting in its season year, the rest walked from there."""
    n = len(sc.rotation)
    p, nxt = sc.rotation[t % n], sc.rotation[(t + 1) % n]
    plant = _on(p.next_plant, start + t)
    prev_harvest = _before(p.prev_harvest, plant)
    w = p.winter
    out: dict[str, Any] = {"plant": plant, "prev_harvest": prev_harvest,
                           "harvest": _after(nxt.prev_harvest, plant), "winter": None}  # fmt: skip
    if w.kind == "cover" and w.seed and w.terminate:
        seed = _after(w.seed, prev_harvest - _DAY)
        out["winter"] = ("cover", w.crop_id, seed, _after(w.terminate, seed))
    elif w.kind == "winter_grain" and w.plant and w.harvest:
        g_plant = _after(w.plant, prev_harvest - _DAY)
        out["winter"] = ("winter_grain", w.crop_id, g_plant, _after(w.harvest, g_plant))
    return out


def _ym(d: date) -> tuple[int, int]:
    return (d.year, d.month)


def _monthly(sc: Scenario, m: Matrices, inp: Inputs, parts: list[tuple[int, str, str, np.ndarray]],
             cur: str | None, assumption: list[str]) -> dict[str, Any] | None:  # fmt: skip
    """The seasons' money laid on a calendar, month by month (timing assumed, amounts calculated).

    Each crop's cost lands in the month it is planted or seeded and its sales in its harvest
    month. Risks sit on the months they describe: a dry pre-planting window on the 30 days
    before planting, heavy rain on bare soil on the off-season months with no living cover.
    """
    runs = m.rain.shape[0]
    dates = [_season_dates(sc, t, inp.start_season) for t in range(inp.years)]
    flows: dict[tuple[int, int], np.ndarray] = {}
    costs: dict[tuple[int, int], np.ndarray] = {}
    revs: dict[tuple[int, int], np.ndarray] = {}
    ops: dict[tuple[int, int], list[dict[str, Any]]] = {}
    risks: dict[tuple[int, int], list[dict[str, Any]]] = {}

    def add(book: dict[tuple[int, int], np.ndarray], ym: tuple[int, int], v: np.ndarray) -> None:
        book[ym] = book.get(ym, np.zeros(runs)) + v
        flows.setdefault(ym, np.zeros(runs))

    for t, crop, kind, values in parts:
        dt, w = dates[t], dates[t]["winter"]
        grain = w is not None and w[0] == "winter_grain" and w[1] == crop
        cover = w is not None and w[0] == "cover" and w[1] == crop
        if kind == "cost":
            when = w[2] if (grain or cover) else dt["plant"]
            add(costs, _ym(when), values)
        else:
            add(revs, _ym(w[3] if grain else dt["harvest"]), values)
    for t, dt in enumerate(dates):
        p = sc.rotation[t % len(sc.rotation)]
        ops.setdefault(_ym(dt["plant"]), []).append({"kind": "plant", "crop_id": p.next_crop_id})
        ops.setdefault(_ym(dt["harvest"]), []).append({"kind": "harvest", "crop_id": p.next_crop_id})
        w = dt["winter"]
        bare = [(dt["prev_harvest"], dt["plant"])]
        if w is not None:
            k0, k1 = ("seed_cover", "end_cover") if w[0] == "cover" else ("plant_grain", "harvest_grain")
            ops.setdefault(_ym(w[2]), []).append({"kind": k0, "crop_id": w[1]})
            ops.setdefault(_ym(w[3]), []).append({"kind": k1, "crop_id": w[1]})
            bare = [(dt["prev_harvest"], w[2]), (w[3], dt["plant"])]
        p_dry = round(float(m.dry[:, t].mean()), 3)
        if p_dry > 0:
            risks.setdefault(_ym(dt["plant"] - 15 * _DAY), []).append({
                "kind": "dry_pre_plant", "probability": p_dry,
                "text": f"Dry 30 days before planting {p.next_crop_id.replace('_', ' ')} in "
                        f"{_pct(p_dry)} of replays"})  # fmt: skip
        p_heavy = round(float((m.heavy[:, t] > 0).mean()), 3)
        spans = [(a + _DAY, b - _DAY) for a, b in bare if b - a > _DAY]
        if p_heavy > 0 and spans:
            # once per off-season, on its first bare month, naming the bare months
            when = " and ".join(f"{a.strftime('%b %Y')}-{b.strftime('%b %Y')}" if _ym(a) != _ym(b)
                                else a.strftime("%b %Y") for a, b in spans)  # fmt: skip
            risks.setdefault(_ym(spans[0][0]), []).append({
                "kind": "heavy_rain_on_bare_soil", "probability": p_heavy,
                "text": f"Heavy rain on bare soil ({when}) in {_pct(p_heavy)} of replays"})  # fmt: skip
    if not flows:
        return None
    first, last = min(flows), max(flows)
    months = []
    cum = np.zeros(runs)
    y, mo = first
    zero = np.zeros(runs)
    while (y, mo) <= last:
        c, r = costs.get((y, mo), zero), revs.get((y, mo), zero)
        net = r - c
        cum = cum + net
        months.append({"month": f"{y:04d}-{mo:02d}", "costs": q(c, 0), "revenue": q(r, 0),
                       "net": q(net, 0), "cumulative_net": q(cum, 0),
                       "operations": ops.get((y, mo), []),
                       "risks": risks.get((y, mo), [])})  # fmt: skip
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return {"currency": cur, "origin": "calculation", "timing_origin": "assumed",
            "timing_text": TIMING_TEXT, "includes_assumption": "+".join(assumption) or None,
            "months": months}  # fmt: skip


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
    method = {"origin": "calculation", "weather": "historical_resampling", "runs": inp.runs, "seed": inp.seed,
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
            "origins": {"crop_families": "calculation", "operations_per_year": "calculation"},
            "operations_per_year": round(float(m.ops.mean()), 2),
            **(money["totals"] or {}),
        }  # fmt: skip
        out.append({"scenario_id": sc.scenario_id, "label": sc.label,
                    "is_baseline": sc.is_baseline, "status": "complete",
                    "timeline": _timeline(sc, inp), "yearly": yearly, "totals": totals,
                    "events": _events(m, inp.years), "money_status": money["money_status"],
                    "monthly": money["monthly"],
                    "money_gaps": money["money_gaps"],
                    "replayed_seasons_sample": [int(y) for y in m.seasons[0]]})  # fmt: skip
    return {"status": "complete", "method": {**method, "money_source": money_source},
            "scenarios": out, "_matrices": mats,
            "crop_money": {c: v.public() for c, v in cm.items()}}  # fmt: skip
