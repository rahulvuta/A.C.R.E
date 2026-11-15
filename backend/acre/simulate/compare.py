"""Scenario comparison and badges (S2; contract §11, simulator.md rule 4).

Badges are "best of the scenarios you compared, given these numbers and past weather". A badge
that cannot be decided fairly (missing money, a tie) is left out and the reason goes in
``not_decided``. Money and weather risk are separate badges and are never combined into a score;
"best for your priorities" uses the P2 weighted-rank method (rank positions, never raw values).
"""

from __future__ import annotations

from typing import Any

from acre.compare.pareto import pareto

CAVEAT = ("The stronger of the plans you compared, given these numbers and the conditions seen at "
          "this field. An evidence-based outlook, not a guarantee.")  # fmt: skip
LOWER, HIGHER = "lower_better", "higher_better"

#: comparison indicator -> (how to read it from totals, direction, label, unit)
METRICS: dict[str, tuple[tuple[str, str | None], str, str, str]] = {
    "margin_10y": (("margin_10y", "median"), HIGHER, "median 10-year margin", "money"),
    "living_cover_days_per_year": (("living_cover_days_per_year", "median"), HIGHER,
                                   "living-cover days a year", "days"),
    "rain_on_bare_soil_mm_per_year": (("rain_on_bare_soil_mm_per_year", "median"), LOWER,
                                      "median rain on bare soil a year", "mm"),
    "heavy_rain_days_on_bare_soil_per_year": (("heavy_rain_days_on_bare_soil_per_year", "median"),
                                              LOWER, "heavy-rain days on bare soil a year", "days"),
    "stress_events": (("stress_events", "mean"), LOWER, "mean weather stress events in the "
                      "period", "events"),
    "crop_families": (("crop_families", None), HIGHER, "crop families", "families"),
    "operations_per_year": (("operations_per_year", None), LOWER, "field operations a year",
                            "operations"),
}  # fmt: skip
SUSTAINABLE = ("living_cover_days_per_year", "rain_on_bare_soil_mm_per_year", "crop_families")
PRIORITY_METRICS: dict[str, tuple[str, ...]] = {
    "soil_cover": ("living_cover_days_per_year", "rain_on_bare_soil_mm_per_year"),
    "water_conservation": ("heavy_rain_days_on_bare_soil_per_year",),
    "weather_resilience": ("stress_events",),
    "crop_diversity": ("crop_families",),
    "living_cover_duration": ("living_cover_days_per_year",),
    "management_simplicity": ("operations_per_year",),
    "profit": ("margin_10y",),
}


def value(sc: dict[str, Any], name: str) -> float | None:
    (key, sub), *_ = METRICS[name]
    v = sc["totals"].get(key)
    if sub is not None:
        v = v.get(sub) if isinstance(v, dict) else None
    return None if v is None else float(v)


def _money(v: float, cur: str | None) -> str:
    sign = "-" if v < 0 else ""
    sym = "$" if cur == "USD" else ""
    tail = "" if cur == "USD" or not cur else f" {cur}"
    return f"{sign}{sym}{abs(round(v)):,}{tail}"


def _fmt(name: str, v: float, cur: str | None = None) -> str:
    unit = METRICS[name][3]
    if unit == "money":
        return _money(v, cur)
    if unit in ("families", "operations") or float(v).is_integer():
        return f"{v:g} {unit}"
    return f"{v:.1f} {unit}"


def _label(sc: dict[str, Any]) -> str:
    return sc.get("label") or sc["scenario_id"]


def _currency(scs: list[dict[str, Any]]) -> str | None:
    for sc in scs:
        m = sc["totals"].get("margin_10y")
        if isinstance(m, dict) and m.get("currency"):
            return m["currency"]
    return None


def _best_single(scs: list[dict[str, Any]], name: str) -> tuple[dict | None, dict | None]:
    """The best scenario on one metric and the runner-up; ``None`` winner on a tie."""
    d = METRICS[name][1]
    ranked = sorted(scs, key=lambda s: value(s, name) * (-1 if d == HIGHER else 1))  # type: ignore[operator]
    if len(ranked) > 1 and value(ranked[0], name) == value(ranked[1], name):
        return None, None
    return ranked[0], ranked[1] if len(ranked) > 1 else None


def _weighted(scs: list[dict[str, Any]], names: list[str], weights: dict[str, float]
              ) -> tuple[str | None, list[str], str | None]:  # fmt: skip
    """P2 method: non-dominated set, then sum(weight x rank position). Returns the winner, the
    shortlist and a tie reason."""
    vectors = {s["scenario_id"]: {n: value(s, n) for n in names} for s in scs}
    res = pareto(vectors, {n: METRICS[n][1] for n in names}, weights)
    if not res.shortlist:
        return None, [], "no scenario has every indicator"
    if len(res.shortlist) == 1:
        return res.shortlist[0], res.shortlist, None

    def key(c: str) -> float:
        return sum(weights.get(n, 1) * res.ranks[c][n] for n in names)

    ordered = sorted(res.shortlist, key=lambda c: (key(c), c))
    a, b = ordered[0], ordered[1]
    if abs(key(a) - key(b)) < 1e-9:
        return None, ordered, "tied on rank positions"
    return a, ordered, None


def compare(scenarios: list[dict[str, Any]], priorities: dict[str, int], years: int = 10
            ) -> dict[str, Any]:  # fmt: skip
    scs = [s for s in scenarios if s.get("status") == "complete"]
    base = next((s for s in scs if s.get("is_baseline")), scs[0] if scs else None)
    out: dict[str, Any] = {"baseline": base["scenario_id"] if base else None, "badges": [],
                           "not_decided": [], "deltas": [], "trade_offs": [], "caveat": CAVEAT}  # fmt: skip
    if not scs:
        return out
    cur = _currency(scs)
    currencies = {(s["totals"].get("margin_10y") or {}).get("currency") for s in scs
                  if value(s, "margin_10y") is not None}
    same_currency = len(currencies) == 1 and None not in currencies
    byid = {s["scenario_id"]: s for s in scs}
    badges, nd = out["badges"], out["not_decided"]
    if len(scs) < 2:
        nd.append({"badge": "all", "reason": "only_one_scenario",
                   "text": "Add another scenario to compare."})  # fmt: skip

    # best_profit: money for every scenario, else left out
    no_money = [_label(s) for s in scs if value(s, "margin_10y") is None]
    if no_money:
        nd.append({"badge": "best_profit", "reason": "money_missing",
                   "text": "Not decided: no money result for " + ", ".join(no_money) +
                           " (add your prices, yields and costs)."})  # fmt: skip
    elif not same_currency:
        nd.append({"badge": "best_profit", "reason": "currency_mismatch",
                   "text": "Not decided: scenario margins use different currencies; "
                           "no exchange rate is assumed."})
    elif len(scs) > 1:
        win, runner = _best_single(scs, "margin_10y")
        if win is None:
            nd.append({"badge": "best_profit", "reason": "tie",
                       "text": "Not decided: the top scenarios have the same median margin."})
        else:
            assumed = win["totals"]["margin_10y"].get("includes_assumption")
            why = (f"Highest median 10-year margin: {_money(value(win, 'margin_10y'), cur)} vs "  # type: ignore[arg-type]
                   f"{_money(value(runner, 'margin_10y'), cur)} for {_label(runner)}.")  # type: ignore[arg-type]
            if assumed:
                why += " Includes your loss assumption (assumed, your estimate)."
            badges.append({"badge": "best_profit", "scenario_id": win["scenario_id"], "why": why})

    if len(scs) > 1:
        # most_sustainable: Pareto-best on soil and water indicators
        names = [n for n in SUSTAINABLE if all(value(s, n) is not None for s in scs)]
        dropped = [n for n in SUSTAINABLE if n not in names]
        win_id, short, tie = _weighted(scs, names, dict.fromkeys(names, 1))
        if win_id is None:
            nd.append({"badge": "most_sustainable", "reason": "tie",
                       "text": f"Not decided: {', '.join(_label(byid[c]) for c in short)} are "
                               "each better on a different soil and water indicator."})  # fmt: skip
        else:
            w = byid[win_id]
            why = ("Best on soil and water: " + "; ".join(
                f"{METRICS[n][2]}: {_fmt(n, value(w, n))}" for n in names) + ".")  # type: ignore[arg-type]
            if len(short) > 1:
                why += " Others are better on one indicator but lower overall in rank."
            if dropped:
                why += f" Not used (missing for a scenario): {', '.join(dropped)}."
            badges.append({"badge": "most_sustainable", "scenario_id": win_id, "why": why})

        # lowest_weather_risk: fewest stress events (mean over runs)
        win, runner = _best_single(scs, "stress_events")
        if win is None:
            nd.append({"badge": "lowest_weather_risk", "reason": "tie",
                       "text": "Not decided: the top scenarios met as many stress events."})
        else:
            badges.append({"badge": "lowest_weather_risk", "scenario_id": win["scenario_id"],
                           "why": f"Fewest weather stress events (dry pre-planting windows and "
                                  f"years with heavy rain on bare soil): {value(win, 'stress_events'):.1f} "
                                  f"on average vs {value(runner, 'stress_events'):.1f} for "  # type: ignore[str-format]
                                  f"{_label(runner)}."})  # type: ignore[arg-type]

        # best_for_priorities: P2 weighted rank over the metrics the priorities name
        # each priority's weight is shared among the metrics it names, so a priority that names
        # two metrics does not count twice
        weights: dict[str, float] = {}
        for p, wgt in (priorities or {}).items():
            ms = PRIORITY_METRICS.get(p, ())
            for n in ms:
                if wgt and wgt > 0:
                    weights[n] = weights.get(n, 0) + wgt / len(ms)
        if not weights:
            weights = {n: 1 for n in METRICS}
        missing = [n for n in weights if any(value(s, n) is None for s in scs)]
        if "margin_10y" in weights and not same_currency and "margin_10y" not in missing:
            missing.append("margin_10y")
        for n in missing:
            weights.pop(n)
        if missing:
            nd.append({"badge": "best_for_priorities", "reason": "indicator_missing",
                       "text": "Left out of 'best for your priorities' (missing for a scenario): "
                               + ", ".join(missing) + "."})  # fmt: skip
        if weights:
            win_id, short, tie = _weighted(scs, list(weights), weights)
            if win_id is None:
                nd.append({"badge": "best_for_priorities", "reason": "tie",
                           "text": "Not decided: the top scenarios rank the same on your "
                                   "priorities."})  # fmt: skip
            else:
                top = sorted(weights, key=lambda n: -weights[n])[:3]
                badges.append({"badge": "best_for_priorities", "scenario_id": win_id,
                               "why": "Ranks best on what you weighted most ("
                                      + ", ".join(METRICS[n][2] for n in top)
                                      + "), using rank positions only (no score)."})  # fmt: skip

    # deltas and trade-offs against the baseline
    for s in scs:
        if base is None or s is base:
            continue
        changes, better, worse = [], [], []
        for n, (_, d, label, unit) in METRICS.items():
            if unit == "money" and not same_currency:
                continue
            a, b = value(s, n), value(base, n)
            if a is None or b is None:
                continue
            delta = a - b
            if unit == "money":
                txt = (f"{'+' if delta >= 0 else '-'}{_money(abs(delta), cur)} over {years} years "
                       "(median)")  # fmt: skip
                changes.append({"indicator": n, "median_delta": round(delta), "currency": cur,
                                "text": txt})  # fmt: skip
            else:
                changes.append({"indicator": n, "delta": round(delta, 2),
                                "text": f"{'+' if delta >= 0 else ''}{round(delta, 1):g} {unit} "
                                        f"({label})"})  # fmt: skip
            if abs(delta) > 1e-9:
                good = (delta > 0) == (d == HIGHER)
                (better if good else worse).append(label)
        out["deltas"].append({"scenario_id": s["scenario_id"], "versus": base["scenario_id"],
                              "changes": changes})  # fmt: skip
        if better or worse:
            txt = ("Better on " + ", ".join(better) if better else "No better on any indicator")
            txt += (", but worse on " + ", ".join(worse) if worse else "") + "."
            out["trade_offs"].append({"scenario_id": s["scenario_id"], "better": better,
                                      "worse": worse, "text": txt})  # fmt: skip
    if years != 10:
        # the wording follows the horizon that was actually run
        def fix(v: Any) -> Any:
            if isinstance(v, str):
                return v.replace("10-year margin", f"{years}-season crop margin")
            if isinstance(v, list):
                return [fix(x) for x in v]
            if isinstance(v, dict):
                return {k: fix(x) for k, x in v.items()}
            return v
        for key in ("badges", "not_decided", "trade_offs", "deltas"):
            out[key] = fix(out[key])
    for key in ("badges", "not_decided", "trade_offs"):
        for item in out[key]:
            item["origin"] = "calculation"
    for delta in out["deltas"]:
        for change in delta["changes"]:
            change["origin"] = "calculation"
    return out
