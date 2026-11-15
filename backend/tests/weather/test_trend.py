"""Climate-trend adjustment: synthetic series only (no network, no grower data)."""

from __future__ import annotations

import numpy as np
import pandas as pd
from fastapi.testclient import TestClient

from acre.api.app import app
from acre.weather import trend
from tests.simulate.test_simulate import NC_SCENARIOS, UNION


def _daily(slope_pct: float, noise: float = 0.02, seed: int = 1) -> pd.DataFrame:
    idx = pd.date_range("1981-01-01", "2025-12-31", freq="D", name="date")
    rng = np.random.default_rng(seed)
    year_scale = 1 + slope_pct / 100 * (idx.year - 1981) / 10
    year_noise = pd.Series(1 + rng.normal(0, noise, 45), index=range(1981, 2026))
    scale = year_scale * year_noise.loc[idx.year].to_numpy()
    return pd.DataFrame({"precip_mm": 2.5 * scale}, index=idx)


def test_significant_wetting_trend_is_applied_and_rain_rises():
    daily = _daily(+8)
    out, rep = trend.adjust(daily, 2032)
    assert rep["applied"] and rep["precip_trend"]["significant"]
    assert rep["precip_trend"]["slope_per_decade"] > 0
    y1981 = daily.loc["1981"].precip_mm.sum()
    assert out.loc["1981"].precip_mm.sum() > y1981  # early dry years shifted up
    lo, hi = rep["factor_range"]
    assert 0.75 <= lo <= hi <= 1.25


def test_no_trend_changes_nothing_and_says_why():
    out, rep = trend.adjust(_daily(0.0, noise=0.1, seed=5), 2032)
    assert out is None and not rep["applied"]
    assert rep["reason"] == "no_significant_precip_trend"


def test_short_record_is_insufficient():
    out, rep = trend.adjust(_daily(5).loc["2005":], 2032)
    assert out is None and rep["reason"] == "insufficient_years"


def test_clamp_limits_extreme_trend():
    _, rep = trend.adjust(_daily(+80, noise=0.01), 2060)
    assert rep["factor_range"][1] <= 1.25 + 1e-9


def test_simulate_endpoint_reports_adjustment_and_default_unchanged(monkeypatch):
    client = TestClient(app)
    base = {"location": UNION, "scenarios": NC_SCENARIOS, "runs": 50}
    plain = client.post("/v1/scenarios/simulate", json=base).json()
    assert plain["method"]["climate_adjustment"] == {"mode": "none"}
    adj = client.post("/v1/scenarios/simulate", json={**base, "climate": "trend"}).json()
    ca = adj["method"]["climate_adjustment"]
    assert ca["mode"] == "trend" and ca["target_year"] == 2031
    if ca["applied"]:
        assert adj["scenarios"] != plain["scenarios"]
    else:
        assert adj["scenarios"][0]["yearly"] == plain["scenarios"][0]["yearly"]
