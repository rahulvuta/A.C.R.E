"""Climate-trend adjustment of a cell's daily weather (opt-in; a scenario, never a forecast).

Historical resampling assumes the past 45 seasons are equally likely draws for the coming ones.
Where the record shows a statistically clear trend in annual precipitation, this module rescales
each past year's daily rain by ``trend_line(target) / trend_line(year)`` so a replayed season looks
like that season would under the observed trend carried to ``target_year``.

* Trend: Theil-Sen slope (robust to outliers) of annual precipitation on year; significance by
  the Mann-Kendall test (normal approximation, no tie correction; annual totals are continuous).
* Applied only when p <= ``ALPHA``. Otherwise nothing changes and the result says why.
* Only years with ``MIN_VALID_DAYS`` valid days count; fewer than ``MIN_YEARS`` such years: no fit.
* The factor is clamped to ``[1 - MAX_SHIFT, 1 + MAX_SHIFT]`` so a short noisy record cannot
  produce an absurd season.
* Temperature trend (annual mean of ``tmean_c``) is reported as context only: no metric reads it.
* Thresholds (heavy rain, dry cutoff) stay frozen from the unadjusted record, so an adjusted
  season is judged against the same yardstick as a historical one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

ALPHA = 0.10
MIN_YEARS = 30
MIN_VALID_DAYS = 360
MAX_SHIFT = 0.25
NOTE = ("Observed trend carried forward; a scenario, not a forecast. Rain in every past season is "
        "rescaled by the fitted trend; temperature is context only.")  # fmt: skip


@dataclass(frozen=True)
class Fit:
    n_years: int
    slope_per_year: float  # Theil-Sen, units of the variable per year
    intercept: float  # median intercept at year 0
    p_value: float

    def line(self, year: float) -> float:
        return self.intercept + self.slope_per_year * year


def _annual(frame: pd.DataFrame, column: str, how: str) -> dict[int, float]:
    if column not in frame.columns:
        return {}
    col = frame[column].astype("float64")
    out: dict[int, float] = {}
    for year, vals in col.groupby(col.index.year):
        valid = vals.dropna()
        if len(valid) >= MIN_VALID_DAYS:
            out[int(year)] = float(valid.sum() if how == "sum" else valid.mean())
    return out


def fit_trend(series: dict[int, float]) -> Fit | None:
    if len(series) < MIN_YEARS:
        return None
    years = np.array(sorted(series), dtype=float)
    vals = np.array([series[int(y)] for y in years])
    n = len(years)
    i, j = np.triu_indices(n, k=1)
    slope = float(np.median((vals[j] - vals[i]) / (years[j] - years[i])))
    intercept = float(np.median(vals - slope * years))
    s = float(np.sign(vals[j] - vals[i]).sum())
    var = n * (n - 1) * (2 * n + 5) / 18
    z = 0.0 if s == 0 else (s - math.copysign(1, s)) / math.sqrt(var)
    return Fit(n, slope, intercept, math.erfc(abs(z) / math.sqrt(2)))


def _fit_public(f: Fit | None, unit: str, mean: float | None) -> dict[str, Any] | None:
    if f is None:
        return None
    return {"slope_per_decade": round(f.slope_per_year * 10, 3), "unit": f"{unit} per decade",
            "p_value": round(f.p_value, 4), "years": f.n_years,
            "significant": f.p_value <= ALPHA, "origin": "calculation",
            "pct_per_decade": (round(100 * f.slope_per_year * 10 / mean, 2) if mean else None)}


def adjust(daily: pd.DataFrame, target_year: int) -> tuple[pd.DataFrame | None, dict[str, Any]]:
    """Return ``(adjusted_daily, report)``. ``adjusted_daily`` is None when nothing was applied.

    ``daily`` is date-indexed with a ``precip_mm`` column. The input is never modified.
    """
    precip = _annual(daily, "precip_mm", "sum")
    temp = _annual(daily, "tmean_c", "mean")
    pf, tf = fit_trend(precip), fit_trend(temp)
    pmean = float(np.mean(list(precip.values()))) if precip else None
    report: dict[str, Any] = {
        "mode": "trend", "target_year": target_year, "alpha": ALPHA, "applied": False,
        "precip_trend": _fit_public(pf, "mm/yr", pmean),
        "temperature_trend": _fit_public(tf, "C", None), "note": NOTE,
        "origin": "calculation", "reason": None, "factor_range": None}  # fmt: skip
    if pf is None:
        report["reason"] = "insufficient_years"
        return None, report
    if pf.p_value > ALPHA:
        report["reason"] = "no_significant_precip_trend"
        return None, report
    lo, hi = 1 - MAX_SHIFT, 1 + MAX_SHIFT
    target = pf.line(target_year)
    factors: dict[int, float] = {}
    for y in precip:
        base = pf.line(y)
        factors[y] = min(hi, max(lo, target / base)) if base > 0 and target > 0 else 1.0
    out = daily.copy()
    f = out.index.year.map(lambda y: factors.get(int(y), 1.0)).to_numpy(dtype="float64")
    out["precip_mm"] = out["precip_mm"].astype("float64") * f
    vals = list(factors.values())
    report.update(applied=True, factor_range=[round(min(vals), 3), round(max(vals), 3)])
    return out, report
