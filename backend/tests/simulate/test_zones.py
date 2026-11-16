# ruff: noqa: F811
"""Field zones: one field, several parts with their own plans, simulated as one whole.
Synthetic plans and economics only (see test_simulate)."""

from __future__ import annotations

import pytest

from tests.simulate.test_simulate import ECON, NC_SCENARIOS, _iso, _plan, _sim, client  # noqa: F401


def _zoned(rot_a, rot_b, a=0.5, b=0.5, **kw):
    sc = [{"scenario_id": "mix", "label": "Mix", "is_baseline": True,
           "zone_rotations": {"a": [_plan(p) for p in rot_a], "b": [_plan(p) for p in rot_b]}}]
    field = {"area_ha": 20.0, "zones": [{"zone_id": "a", "name": "North", "share": a},
                                        {"zone_id": "b", "name": "South", "share": b}]}
    return sc, field


def test_one_zone_matches_no_zones(client):
    whole = _sim(client, economics={"overrides": ECON}, field={"area_ha": 20.0})
    sc = [{"scenario_id": s["scenario_id"], "label": s["label"], "is_baseline": s["is_baseline"],
           "zone_rotations": {"all": s["timeline"] and r["rotation"]}}
          for s, r in zip(whole["scenarios"], NC_SCENARIOS, strict=True)]
    field = {"area_ha": 20.0, "zones": [{"zone_id": "all", "share": 1.0}]}
    one = _sim(client, sc, economics={"overrides": ECON}, field=field)
    for a, b in zip(whole["scenarios"], one["scenarios"], strict=True):
        assert a["totals"] == b["totals"] and a["yearly"] == b["yearly"]


def test_identical_zones_equal_the_whole_field(client):
    whole = _sim(client, economics={"overrides": ECON}, field={"area_ha": 20.0})
    sc = [{"scenario_id": r["scenario_id"], "label": r["label"], "is_baseline": r["is_baseline"],
           "zone_rotations": {"a": r["rotation"], "b": r["rotation"]}} for r in NC_SCENARIOS]
    field = {"area_ha": 20.0, "zones": [{"zone_id": "a", "share": 0.3}, {"zone_id": "b", "share": 0.7}]}
    z = _sim(client, sc, economics={"overrides": ECON}, field=field)
    for a, b in zip(whole["scenarios"], z["scenarios"], strict=True):
        for k in ("margin_10y", "costs_total", "revenue_total"):
            for q in ("p10", "median", "p90"):
                assert abs(a["totals"][k][q] - b["totals"][k][q]) <= 2  # rounding only
        assert a["totals"]["stress_events"] == b["totals"]["stress_events"]


def test_mixed_crops_are_one_result_with_zone_detail(client):
    sc, field = _zoned(["corn_soy__no_cover", "soy_corn__no_cover"],
                       ["soy_corn__no_cover", "corn_soy__no_cover"])
    out = _sim(client, sc, economics={"overrides": ECON}, field=field)
    (s,) = out["scenarios"]
    assert len(s["zones"]) == 2 and {z["zone_id"] for z in s["zones"]} == {"a", "b"}
    assert s["zones"][0]["timeline"][0]["plan_id"] != s["zones"][1]["timeline"][0]["plan_id"]
    assert out["field"]["zones"][0]["area_ha"] == 10.0
    assert s["money_status"] == "complete" and s["totals"]["margin_10y"]["median"] is not None
    ops = [o for m in s["monthly"]["months"] for o in m["operations"]]
    assert {o["zone_id"] for o in ops} == {"a", "b"}


def test_zone_sizes_in_hectares_give_the_field_area(client):
    sc, _ = _zoned(["corn_soy__no_cover"], ["corn_soy__no_cover"])
    field = {"zones": [{"zone_id": "a", "area_ha": 6}, {"zone_id": "b", "area_ha": 4}]}
    out = _sim(client, sc, economics={"overrides": ECON}, field=field)
    assert out["field"]["area_ha"] == 10.0 and out["field"]["area_origin"] == "calculation"
    assert out["field"]["zones"][0]["share"] == 0.6


@pytest.mark.parametrize("zones,code", [
    ([{"zone_id": "a", "share": 0.5}, {"zone_id": "b", "share": 0.3}], "zones_share_sum"),
    ([{"zone_id": "a", "share": 0.5}, {"zone_id": "a", "share": 0.5}], "duplicate_zone_id"),
    ([{"zone_id": "a", "share": 0.5}, {"zone_id": "b", "area_ha": 5}], "zones_mixed_size"),
    ([{"zone_id": "a"}, {"zone_id": "b", "share": 1}], "zone_size_missing"),
    ([{"zone_id": "a", "area_ha": 15}, {"zone_id": "b", "area_ha": 9}], "zones_exceed_field"),
])
def test_bad_zones_are_rejected(client, zones, code):
    sc, _ = _zoned(["corn_soy__no_cover"], ["corn_soy__no_cover"])
    body = {"location": {"latitude": 34.98, "longitude": -80.55}, "scenarios": sc,
            "field": {"area_ha": 20.0, "zones": zones}}
    r = client.post("/v1/scenarios/simulate", json=body)
    assert r.status_code == 400 and code in {i["code"] for i in r.json()["issues"]}


def test_zone_rotation_rules(client):
    base = {"location": {"latitude": 34.98, "longitude": -80.55}, "field": {"area_ha": 10.0,
            "zones": [{"zone_id": "a", "share": 0.5}, {"zone_id": "b", "share": 0.5}]}}
    plan = _plan("corn_soy__no_cover")
    missing = {"scenario_id": "x", "zone_rotations": {"a": [plan]}}
    r = client.post("/v1/scenarios/simulate", json={**base, "scenarios": [missing]})
    assert "zone_rotation_missing" in {i["code"] for i in r.json()["issues"]}
    unknown = {"scenario_id": "x", "rotation": [plan], "zone_rotations": {"zz": [plan]}}
    r = client.post("/v1/scenarios/simulate", json={**base, "scenarios": [unknown]})
    assert "unknown_zone" in {i["code"] for i in r.json()["issues"]}
    default = {"scenario_id": "x", "rotation": [plan], "zone_rotations": {"a": [plan]}}
    r = client.post("/v1/scenarios/simulate", json={**base, "scenarios": [default]})
    assert r.status_code == 200  # zone b falls back to the default rotation
