"""Scenario simulator (S1, S2): resampling, distributions, events, money, badges. Offline: NC uses
the committed Union County snapshot, Pergamino the recorded POWER fixture. Plans and economics
values are synthetic test inputs."""

from __future__ import annotations

import time
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from acre.api.samples import load_samples
from acre.simulate import money, seasons
from acre.simulate.compare import compare
from acre.simulate.engine import MIN_POOL, draws
from acre.weather import ondemand
from tests.compare.test_global_analysis import PERG, _prepare
from tests.compare.test_global_analysis import PLAN as PERG_PLAN

UNION = {"latitude": 34.98, "longitude": -80.55}
REAL_LIBRARY = money._library
STATUS = {"complete", "partial", "unavailable", "unknown", "inapplicable", "unsupported",
          "invalid_input", "manual_check", "insufficient_data"}  # fmt: skip
ORIGINS = {"nasa_measured", "nasa_modeled", "calculation", "verified_source", "source_checked",
           "ai_suggested", "grower", "assumed", "dataset_estimate"}  # fmt: skip
ECON = {  # synthetic farmer numbers for the tests
    "field_corn": {"price": {"value": 4.5, "unit": "USD/bu"}, "yield": {"value": 170, "unit": "bu/acre"},
                   "costs": {"value": 700, "unit": "USD/acre"}},
    "soybean": {"price": {"value": 11.2, "unit": "USD/bu"}, "yield": {"value": 48, "unit": "bu/acre"},
                "costs": {"value": 410, "unit": "USD/acre"}},
    "cereal_rye": {"costs": {"value": 45, "unit": "USD/acre"}},
    "crimson_clover": {"costs": {"value": 55, "unit": "USD/acre"}},
}  # fmt: skip


def _plan(pid: str) -> dict[str, Any]:
    return load_samples().plans[pid].plan.model_dump(mode="json")


def _sc(sid: str, *pids: str, base: bool = False, label: str | None = None) -> dict[str, Any]:
    return {"scenario_id": sid, "label": label or sid, "is_baseline": base,
            "rotation": [_plan(p) for p in pids]}  # fmt: skip


NC_SCENARIOS = [
    _sc("current", "corn_soy__no_cover", "soy_corn__no_cover", base=True, label="What I do now"),
    _sc("rye", "corn_soy__rye", "soy_corn__rye", label="Add cereal rye"),
]


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv(ondemand.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    ondemand.reset_jobs()
    seasons.clear_cache()
    # B's S3 library is pinned off: these tests check the grower-only path (see the fake below)
    monkeypatch.setattr(money, "_library", lambda *a, **k: None)
    yield
    ondemand.set_fetch(None)
    ondemand.reset_jobs()


@pytest.fixture
def client() -> TestClient:
    from acre.api.app import create_app

    return TestClient(create_app())


def _sim(client, scenarios=None, **kw) -> dict[str, Any]:
    body = {"location": kw.pop("location", UNION), "scenarios": scenarios or NC_SCENARIOS,
            "years": 10, "runs": 200, "seed": 7, "start_season": "2027", **kw}  # fmt: skip
    r = client.post("/v1/scenarios/simulate", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _walk(obj, key):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from _walk(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v, key)


def test_simulate_shape_vocab_and_label(client):
    out = _sim(client)
    assert out["status"] == "complete"
    assert out["method"]["weather"] == "historical_resampling"
    assert "not a forecast" in out["method"]["note"]
    assert out["method"]["pool_years"] >= MIN_POOL
    assert all(e["origin"] == "calculation" for s in out["scenarios"] for e in s["events"])
    assert out["meta"]["plan_version"].startswith("sim_") and out["meta"]["snapshot_hash"]
    assert set(_walk(out, "status")) <= STATUS
    assert set(_walk(out, "origin")) - {None} <= ORIGINS
    cur, rye = out["scenarios"]
    assert [t["year"] for t in cur["timeline"]] == list(range(2027, 2037))
    assert cur["timeline"][0]["plan_id"] == "corn_soy__no_cover"
    assert cur["timeline"][1]["plan_id"] == "soy_corn__no_cover"  # the rotation is cycled
    assert cur["timeline"][2]["plan_id"] == "corn_soy__no_cover"
    y0 = rye["yearly"][0]["indicators"]
    r = y0["rain_on_bare_soil_mm"]
    assert r["p10"] <= r["median"] <= r["p90"]
    assert 0 <= y0["dry_pre_plant"]["probability"] <= 1
    assert y0["living_cover_days"]["median"] > 0
    assert cur["yearly"][0]["indicators"]["living_cover_days"]["median"] == 0
    assert {e["event"] for e in cur["events"]} >= {"dry_springs_ge_3_in_10y",
                                                   "back_to_back_dry_springs"}  # fmt: skip
    assert all("replays" in e["text"] for e in cur["events"])
    assert cur["totals"]["crop_families"] == 2
    # cover cuts rain on bare soil; the weather each plan meets is the same past weather
    assert (rye["totals"]["rain_on_bare_soil_mm_per_year"]["median"]
            < cur["totals"]["rain_on_bare_soil_mm_per_year"]["median"])  # fmt: skip
    assert "same sequence" in out["method"]["draws"]


def test_deterministic_with_a_seed_and_different_with_another(client):
    a, b = _sim(client), _sim(client)
    for x in (a, b):
        x.pop("meta")
    assert a == b
    c = _sim(client, seed=8)
    assert (c["scenarios"][0]["replayed_seasons_sample"]
            != a["scenarios"][0]["replayed_seasons_sample"])  # fmt: skip


def test_identical_scenarios_get_identical_results(client):
    out = _sim(client, [_sc("a", "corn_soy__rye", base=True), _sc("b", "corn_soy__rye")])
    a, b = out["scenarios"]
    assert a["yearly"] == b["yearly"] and a["events"] == b["events"]


def test_resampling_only_draws_evaluable_seasons():
    from acre.compare import engine
    from acre.compare.context import get_context
    from acre.contracts import Plan

    ctx = get_context()
    p = Plan.model_validate(_plan("corn_soy__rye"))
    ts = engine.threshold_set_for(ctx, [p.next_plant])
    leg = seasons.leg_seasons(p, ctx, ts)
    assert leg is seasons.leg_seasons(p, ctx, ts)  # computed once
    d = draws([leg], 300, 10, 1)
    assert set(np.array(d.pool)[d.index].ravel()) <= leg.evaluable()
    # every past season value equals the P2 engine's own season row
    pc = engine.analyze_plan(p, ctx, ts)[0]
    rows = {r.year: r for r in pc.seasons}
    for i, y in enumerate(leg.years):
        r = rows[y]
        if r.rain_outside_cover_mm is not None and not np.isnan(leg.rain_bare_mm[i]):
            assert leg.rain_bare_mm[i] == pytest.approx(r.rain_outside_cover_mm)
            assert leg.heavy_bare_days[i] == r.heavy_rain_days_outside_cover
        if r.spring_is_dry is not None:
            assert bool(leg.dry[i]) == r.spring_is_dry
    assert leg.living_cover_days == pc.calendar.living_cover_days_planned


def test_too_few_evaluable_seasons_is_insufficient_data():
    class Leg:
        def evaluable(self):
            return {1990, 1991}

    d = draws([Leg()], 50, 10, 1)  # type: ignore[list-item]
    assert len(d.pool) == 2 < MIN_POOL


def test_two_hundred_runs_six_scenarios_under_three_seconds(client):
    pids = ["corn_soy__no_cover", "corn_soy__rye", "corn_soy__clover", "soy_corn__no_cover",
            "soy_corn__rye"]  # fmt: skip
    scs = [_sc(f"s{i}", pids[i % 5], pids[(i + 1) % 5], base=i == 0) for i in range(6)]
    seasons.clear_cache()
    t = time.perf_counter()
    out = _sim(client, scs, economics={"overrides": ECON}, field={"area_ha": 16.2})
    assert time.perf_counter() - t < 3.0
    assert len(out["scenarios"]) == 6


@pytest.mark.parametrize("patch", [{"runs": 49}, {"runs": 501}, {"years": 11}, {"years": 0},
                                   {"scenarios": [_sc(f"s{i}", "corn_soy__rye") for i in range(7)]},
                                   {"start_season": "27"}])  # fmt: skip
def test_limits_are_typed_400(client, patch):
    body = {"location": UNION, "scenarios": NC_SCENARIOS, **patch}
    r = client.post("/v1/scenarios/simulate", json=body)
    assert r.status_code == 400 and r.json()["status"] == "invalid_input"


def test_bad_scenarios_are_typed(client):
    two = [_sc("a", "corn_soy__rye", base=True), _sc("a", "corn_soy__rye", base=True)]
    r = client.post("/v1/scenarios/simulate", json={"location": UNION, "scenarios": two})
    codes = {i["code"] for i in r.json()["issues"]}
    assert r.status_code == 400 and {"duplicate_scenario_id", "two_baselines"} <= codes


# ---- money (S2) -------------------------------------------------------------------------------

def test_money_without_assumption_never_moves_with_weather(client):
    out = _sim(client, economics={"overrides": ECON}, field={"area_ha": 16.2})
    cur = out["scenarios"][0]
    assert cur["money_status"] == "complete" and out["method"]["money_source"] == "grower_only"
    m = cur["totals"]["margin_10y"]
    assert m["p10"] == m["median"] == m["p90"] and m["includes_assumption"] is None
    assert cur["totals"]["weather_link"].startswith("none")
    # 2027 (corn -> soybean): 48 bu/acre x $11.20 x 40.03 acres - $410/acre x 40.03 acres
    acres = 16.2 / 0.40468564224
    y = cur["yearly"][0]["money"]
    assert y["margin"]["median"] == round(48 * 11.2 * acres - 410 * acres)
    assert out["crop_money"]["soybean"]["price"]["origin"] == "grower"


def test_loss_assumption_applies_only_in_event_years(client):
    out = _sim(client, economics={"overrides": ECON, "loss_assumptions": {"dry_spring_pct": 20}},
               field={"area_ha": 16.2})  # fmt: skip
    cur = out["scenarios"][0]
    m = cur["totals"]["margin_10y"]
    assert m["includes_assumption"] == "dry_spring_pct" and m["p10"] < m["p90"]
    assert "assumed" in cur["totals"]["weather_link"]
    acres = 16.2 / 0.40468564224
    full = round(48 * 11.2 * acres - 410 * acres)
    y = cur["yearly"][0]["money"]["margin"]
    assert y["p90"] == full and y["p10"] == round(48 * 11.2 * 0.8 * acres - 410 * acres)


def test_missing_money_is_blank_and_profit_badge_not_decided(client):
    ov = {k: v for k, v in ECON.items() if k != "cereal_rye"}  # the rye scenario has no rye cost
    out = _sim(client, economics={"overrides": ov}, field={"area_ha": 16.2})
    cur, rye = out["scenarios"]
    assert cur["money_status"] == "complete"
    assert rye["money_status"] in ("partial", "unavailable") and rye["money_gaps"]
    assert "margin_10y" not in rye["totals"]
    assert all(y["money"] is None for y in rye["yearly"])
    c = out["comparison"]
    assert "best_profit" not in {b["badge"] for b in c["badges"]}
    assert any(n["badge"] == "best_profit" for n in c["not_decided"])


def test_no_area_means_no_money(client):
    out = _sim(client, economics={"overrides": ECON})
    assert out["scenarios"][0]["money_status"] == "unavailable"
    assert out["scenarios"][0]["money_gaps"][0]["reason"] == "no_area"


def test_area_from_geometry(client):
    sq = {"type": "Polygon", "coordinates": [[[-80.56, 34.98], [-80.55, 34.98], [-80.55, 34.97],
                                              [-80.56, 34.97], [-80.56, 34.98]]]}  # fmt: skip
    out = _sim(client, economics={"overrides": ECON}, field={"geometry": sq})
    assert out["field"]["area_origin"] == "calculation" and out["field"]["area_ha"] > 50
    assert out["scenarios"][0]["money_status"] == "complete"


def test_unit_mismatch_is_a_gap_not_a_guess(client):
    ov = {**ECON, "soybean": {**ECON["soybean"], "yield": {"value": 3.2, "unit": "t/ha"}}}
    out = _sim(client, economics={"overrides": ov}, field={"area_ha": 16.2})
    gaps = out["scenarios"][0]["money_gaps"]
    assert any(g["reason"] == "unit_mismatch" for g in gaps)


# ---- comparison (S2) --------------------------------------------------------------------------

def test_badges_deltas_trade_offs_and_caveat(client):
    out = _sim(client, economics={"overrides": ECON}, field={"area_ha": 16.2},
               goals={"priorities": {"soil_cover": 3, "profit": 1}})  # fmt: skip
    c = out["comparison"]
    assert c["baseline"] == "current" and "Not a forecast" in c["caveat"]
    badges = {b["badge"]: b for b in c["badges"]}
    assert badges["most_sustainable"]["scenario_id"] == "rye"
    assert badges["best_profit"]["scenario_id"] == "current"  # rye only adds a cost here
    assert "$" in badges["best_profit"]["why"]
    assert badges["best_for_priorities"]["scenario_id"] == "rye"  # soil cover weighted 3, profit 1
    assert all(b["why"] for b in c["badges"])
    (d,) = c["deltas"]
    margin = next(x for x in d["changes"] if x["indicator"] == "margin_10y")
    assert margin["median_delta"] < 0 and "over 10 years" in margin["text"]
    (t,) = c["trade_offs"]
    assert "living-cover days a year" in t["better"] and "median 10-year margin" in t["worse"]


def test_priority_weights_are_shared_among_their_metrics(client):
    """soil_cover names two metrics; with profit 3 and soil cover 2 it must not count double."""
    out = _sim(client, economics={"overrides": ECON}, field={"area_ha": 16.2},
               goals={"priorities": {"soil_cover": 2, "profit": 3}})  # fmt: skip
    badges = {b["badge"]: b["scenario_id"] for b in out["comparison"]["badges"]}
    assert badges["best_for_priorities"] == "current"


def test_one_scenario_has_no_badges(client):
    out = _sim(client, NC_SCENARIOS[:1])
    assert out["comparison"]["badges"] == []
    assert out["comparison"]["not_decided"][0]["reason"] == "only_one_scenario"


def test_ties_are_not_decided():
    sc = {"status": "complete", "totals": {"stress_events": {"mean": 2.0},
                                           "living_cover_days_per_year": {"median": 10},
                                           "rain_on_bare_soil_mm_per_year": {"median": 5},
                                           "crop_families": 2, "operations_per_year": 4,
                                           "heavy_rain_days_on_bare_soil_per_year": {"median": 1}}}  # fmt: skip
    c = compare([{**sc, "scenario_id": "a", "is_baseline": True}, {**sc, "scenario_id": "b"}], {})
    assert c["badges"] == []
    assert {n["badge"] for n in c["not_decided"]} >= {"lowest_weather_risk", "most_sustainable",
                                                      "best_for_priorities", "best_profit"}  # fmt: skip


# ---- readings, global, vocab ------------------------------------------------------------------

def test_readings_sit_beside_modeled_values(client):
    field = {"readings": [{"date": "2020-04-02", "kind": "soil_moisture_pct", "value": 23.5,
                           "depth_cm": 10},
                          {"date": "2026-04-02", "kind": "rainfall_mm", "value": 12.0}]}  # fmt: skip
    out = _sim(client, field=field)
    a, b = out["scenarios"][0]["readings_context"]
    assert a["origin"] == "grower" and a["value"] == 23.5
    assert a["modeled_same_day"]["origin"] == "nasa_modeled" and "gwettop" in a["modeled_same_day"]
    assert b["modeled_same_day"] is None and "outside the weather record" in b["modeled_same_day_reason"]
    t = b["modeled_typical_for_date"]
    assert t["variable"] == "precip_mm" and t["origin"] == "nasa_modeled"
    # readings never enter the run: the same request without them gives the same indicators
    plain = _sim(client)
    assert plain["scenarios"][0]["yearly"] == out["scenarios"][0]["yearly"]


def test_pergamino_runs_on_the_prepared_cell(client):
    _prepare()
    bare = {**PERG_PLAN, "plan_id": "perg_bare", "winter": {"kind": "none"}}
    out = _sim(client, [{"scenario_id": "now", "rotation": [bare]},
                        {"scenario_id": "rye", "rotation": [PERG_PLAN]}], location=PERG)  # fmt: skip
    assert out["status"] == "complete"
    assert out["meta"]["catalog_version"] and "US-NC" not in str(out["meta"]["catalog_version"])
    assert out["scenarios"][0]["is_baseline"]  # no baseline flagged: the first one


def test_unprepared_point_is_unavailable_not_an_error(client):
    out = _sim(client, [{"scenario_id": "rye", "rotation": [PERG_PLAN]}], location=PERG)
    assert out["status"] == "unavailable"
    assert out["code"] in ("weather_not_prepared", "offline_no_snapshot")
    assert out["scenarios"] == []


def test_vocab_priorities_includes_profit_and_recommend_accepts_it(client):
    v = client.get("/v1/vocab/priorities").json()
    ids = [p["priority_id"] for p in v["priorities"]]
    assert "profit" in ids and all(p["label"] and p["explanation"] for p in v["priorities"])
    r = client.post("/v1/plans/recommend", json={
        "location": UNION, "goals": {"priorities": {"profit": 3, "soil_cover": 1}},
        "candidates": [{"candidate_id": "a", "plans": [_plan("corn_soy__rye")]}]})  # fmt: skip
    assert r.status_code == 200, r.text


def test_library_records_are_read_with_their_origins(monkeypatch):
    """B's library resolves the farmer's value first, then references; its records are read as
    given (origin per value), and crops it has no record for stay blank."""
    def fake(location, crops, area, equipment, overrides):
        return {"crops": [{"crop_id": "soybean",
                           "price": {"low": 9.5, "typical": 11.2, "high": 13.6, "unit": "USD/bu",
                                     "origin": "grower"},
                           "yield": {"value": 44, "unit": "bu/acre", "origin": "dataset_estimate"},
                           "costs": {"items": [{"item": "seed", "value": 62, "unit": "USD/acre",
                                                "origin": "verified_source"}],
                                     "total_per_area": {"value": 400, "unit": "USD/acre"}}}]}  # fmt: skip

    monkeypatch.setattr(money, "_library", fake)
    cm, src = money.crop_money({}, ["soybean", "okra"], 10.0, [], {})
    assert src == "economics_library"
    soy = cm["soybean"]
    assert soy.status == "complete" and soy.price == 11.2 and soy.yield_per_area == 44
    assert soy.cost_per_area == 400 and (soy.price_low, soy.price_high) == (9.5, 13.6)
    assert soy.origins == {"price": "grower", "yield": "dataset_estimate", "costs": "verified_source"}
    assert cm["okra"].status == "unavailable" and cm["okra"].price is None


def test_with_b_economics_library_end_to_end(client, monkeypatch):
    monkeypatch.setattr(money, "_library", REAL_LIBRARY)  # the real S3 library, not the pin
    out = _sim(client, economics={"overrides": ECON}, field={"area_ha": 16.2})
    assert out["method"]["money_source"] == "economics_library"
    cur = out["scenarios"][0]
    assert cur["money_status"] == "complete"
    acres = 16.2 / 0.40468564224
    assert cur["yearly"][0]["money"]["margin"]["median"] == round(48 * 11.2 * acres - 410 * acres)
    bad = client.post("/v1/scenarios/simulate", json={
        "location": UNION, "scenarios": NC_SCENARIOS, "field": {"area_ha": 16.2},
        "economics": {"overrides": {"soybean": {"costs": "lots"}}}})  # fmt: skip
    assert bad.status_code == 400 and bad.json()["issues"][0]["field"].startswith("economics.")


def test_costs_per_hectare_convert_to_the_yield_area_unit():
    cm = money._from_record("soybean", {"value": 11.2, "unit": "USD/bu"},
                            {"value": 48, "unit": "bu/acre"}, {"value": 1000, "unit": "USD/ha"}, {})
    assert cm.area_unit == "acre" and cm.cost_per_area == pytest.approx(1000 * 0.40468564224)


def test_harvested_yield_and_planted_costs_do_not_make_a_margin():
    cm = money._from_record("soybean", {"value": 11.2, "unit": "USD/bu"},
                            {"value": 48, "unit": "bu/acre", "area_basis": "harvested"},
                            {"value": 410, "unit": "USD/acre", "area_basis": "planted"}, {})
    assert cm.status == "partial" and cm.cost_per_area is None
    assert any(g["reason"] == "area_basis_mismatch" for g in cm.gaps)


def test_exact_mass_units_can_be_combined_without_bushel_assumptions():
    cm = money._from_record("soybean", {"value": 0.35, "unit": "USD/kg"},
                            {"value": 3.2, "unit": "t/ha"},
                            {"value": 650, "unit": "USD/ha"}, {})
    assert cm.status == "complete" and cm.yield_per_area == 3200
    assert cm.price * cm.yield_per_area - cm.cost_per_area == pytest.approx(470)


def test_zero_loss_is_an_explicit_assumption(client):
    out = _sim(client, economics={"overrides": ECON, "loss_assumptions": {"dry_spring_pct": 0}},
               field={"area_ha": 16.2})
    assert out["scenarios"][0]["totals"]["margin_10y"]["includes_assumption"] == "dry_spring_pct"


def test_different_currencies_have_no_profit_badge_or_money_delta(client):
    scs = _sim(client, economics={"overrides": ECON}, field={"area_ha": 16.2})["scenarios"]
    scs[1]["totals"]["margin_10y"]["currency"] = "ARS"
    out = compare(scs, {"profit": 3})
    assert not any(b["badge"] in {"best_profit", "best_for_priorities"} for b in out["badges"])
    assert any(n["reason"] == "currency_mismatch" for n in out["not_decided"])
    assert not any(c["indicator"] == "margin_10y" for d in out["deltas"] for c in d["changes"])


def test_unused_rotation_seasons_do_not_change_one_year_indicators(client):
    baseline = _sc("short", "corn_soy__no_cover", base=True)
    longer = _sc("long", "corn_soy__no_cover", "soy_corn__rye")
    out = _sim(client, [baseline, longer], years=1)
    assert out["scenarios"][0]["yearly"] == out["scenarios"][1]["yearly"]
    assert out["scenarios"][0]["totals"] == out["scenarios"][1]["totals"]


def test_replay_readings_stay_separate_from_weather(client):
    body = {"plan": _plan("corn_soy__no_cover"), "location": UNION}
    baseline = client.post("/v1/seasons/2020/replay", json=body).json()
    reading = {"date": "2020-04-02", "kind": "rainfall_mm", "value": 0}
    response = client.post("/v1/seasons/2020/replay", json={**body,
                           "field": {"equipment": ["planter"], "readings": [reading]}})
    assert response.status_code == 200
    out = response.json()
    assert out["readings_context"][0]["value"] == 0
    assert out["readings_context"][0]["origin"] == "grower"
    assert out["readings_context"][0]["modeled_same_day"]["origin"] == "nasa_modeled"
    assert out["daily"] == baseline["daily"] and out["spring"] == baseline["spring"]


# --------------------------------------------------------------------------- month by month (cash calendar)


def test_monthly_calendar_adds_up_to_the_yearly_money_and_marks_timing_assumed(client):
    body = _sim(client, years=5, field={"area_ha": 16.2},
                economics={"overrides": ECON, "loss_assumptions": {"dry_spring_pct": 20}})  # fmt: skip
    for sc in body["scenarios"]:
        cal = sc["monthly"]
        assert cal["timing_origin"] == "assumed" and cal["origin"] == "calculation"
        assert "harvest month" in cal["timing_text"]
        months = [m["month"] for m in cal["months"]]
        # consecutive months, no gaps
        ys = [int(m[:4]) * 12 + int(m[5:]) - 1 for m in months]
        assert ys == list(range(ys[0], ys[0] + len(ys)))
        # costs are fixed per season, so their monthly medians sum to the yearly medians
        assert sum(m["costs"]["median"] for m in cal["months"]) == pytest.approx(
            sum(y["money"]["costs"]["median"] for y in sc["yearly"]), abs=len(months))
        # the last cumulative net is the horizon margin (same runs, same medians)
        assert cal["months"][-1]["cumulative_net"]["median"] == pytest.approx(
            sc["totals"]["margin_10y"]["median"], abs=2)
        tot = sc["totals"]
        assert tot["costs_total"]["median"] == pytest.approx(
            sum(m["costs"]["median"] for m in cal["months"]), abs=len(months))
        assert tot["revenue_total"]["origin"] == "calculation"
        ops = {(o["kind"], o["crop_id"]) for m in cal["months"] for o in m["operations"]}
        assert ("plant", "soybean") in ops and ("harvest", "field_corn") in ops
        # soybean planted 05-12 in 2027: costs land in May 2027, sales in that autumn's harvest
        may = next(m for m in cal["months"] if m["month"] == "2027-05")
        assert may["costs"]["median"] > 0 and may["revenue"]["median"] == 0
    rye = next(s for s in body["scenarios"] if s["scenario_id"] == "rye")
    kinds = {o["kind"] for m in rye["monthly"]["months"] for o in m["operations"]}
    assert {"seed_cover", "end_cover"} <= kinds
    risk = [r for m in rye["monthly"]["months"] for r in m["risks"]]
    assert all(0 < r["probability"] <= 1 and r["text"] for r in risk)


def test_monthly_calendar_is_null_without_money(client):
    body = _sim(client, years=3)  # no area or economics
    assert all(sc["monthly"] is None for sc in body["scenarios"])


def test_monthly_running_totals_and_field_conditions(client):
    body = _sim(client, years=5, field={"area_ha": 16.2}, economics={"overrides": ECON})
    months = body["scenarios"][0]["monthly"]["months"]
    last = months[-1]
    # costs are fixed per season, so the running cost is the sum of the monthly costs
    # (each month is rounded to whole currency units, so allow one unit per month)
    assert abs(last["cumulative_costs"]["median"] - sum(m["costs"]["median"] for m in months)) <= len(months)
    assert last["cumulative_revenue"]["median"] >= months[0]["cumulative_revenue"]["median"]
    cond = body["field_conditions"]
    assert cond["origin"] == "nasa_modeled"
    assert [m["month"] for m in cond["months"]] == list(range(1, 13))
    june = cond["months"][5]
    assert 0 <= june["soil_wetness_top"]["p10"] <= june["soil_wetness_top"]["median"] <= 1
    assert june["rain_mm"]["median"] > 0
