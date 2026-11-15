"""S5: equipment and readings in the field context, the vocab routes and generator feasibility."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from acre.field import equipment as eq
from acre.planner.goals import FieldContext


@pytest.fixture(scope="module")
def api():
    from acre.api.app import create_app

    return TestClient(create_app())


def test_field_context_accepts_vocab_equipment_and_readings():
    fc = FieldContext.model_validate({
        "field_id": "f1", "name": "North 40", "area_ha": 16.2, "geometry": None,
        "equipment": ["planter", "sprayer", "other:manure spreader", "planter"],
        "readings": [{"date": "2026-04-02", "kind": "soil_moisture_pct", "value": 23.5,
                      "depth_cm": 10},
                     {"date": "2026-03-01", "kind": "note", "note": "standing water low end"},
                     {"date": "2026-03-05", "kind": "rainfall_mm", "value": 0}]})  # fmt: skip
    assert fc.equipment == ["other:manure spreader", "planter", "sprayer"]
    assert [r.kind for r in fc.readings] == ["note", "rainfall_mm", "soil_moisture_pct"]
    ctx = eq.readings_context(fc.readings)
    assert ctx[1]["value"] == 0 and all(r["origin"] == "grower" for r in ctx)  # 0 stays 0


@pytest.mark.parametrize("field", [
    {"equipment": ["jetpack"]},
    {"equipment": ["other:"]},
    {"readings": [{"date": "2026-04-02", "kind": "soil_moisture_pct"}]},  # blank is not zero
    {"readings": [{"date": "2026-04-02", "kind": "soil_moisture_pct", "value": 140}]},
    {"readings": [{"date": "2026-04-02", "kind": "soil_moisture_vwc", "value": 1.5}]},
    {"readings": [{"date": "2026-04-02", "kind": "ph", "value": 6}]},
    {"readings": [{"date": "2026-02-30", "kind": "rainfall_mm", "value": 3}]},
    {"readings": [{"date": "2026-04-02", "kind": "note"}]},
    {"readings": [{"date": "2026-04-02", "kind": "note", "note": "x", "value": 3}]},
])  # fmt: skip
def test_bad_equipment_and_readings_are_rejected(field):
    with pytest.raises(ValidationError):
        FieldContext.model_validate(field)


def test_vocab_routes(api):
    e = api.get("/v1/vocab/equipment").json()
    ids = [x["id"] for x in e["equipment"]]
    assert ids[:2] == ["planter", "grain_drill"] and "other:<text>" in ids
    assert set(eq.EQUIPMENT) <= set(ids) and all(x["label"] for x in e["equipment"])
    r = api.get("/v1/vocab/readings").json()
    assert {x["kind"] for x in r["readings"]} == {"soil_moisture_pct", "soil_moisture_vwc",
                                                      "rainfall_mm", "soil_temp_c", "note", "soil_ph",
                                                      "organic_matter_pct", "salinity_ds_m", "custom"}  # fmt: skip
    assert "meta" in e and "meta" in r


class _Rule:
    def __init__(self, **kw):
        self.rule_id, self.origin, self.source_url = "r1", "verified_source", "https://x.edu"
        self.management_action = self.value_text = self.guidance = self.applies_when = None
        self.__dict__.update(kw)


def test_feasibility_steps():
    none = eq.season_feasibility([], "soybean", "cereal_rye", [])
    assert none["status"] == "unknown"
    full = eq.season_feasibility(["no_till_drill", "roller_crimper"], "soybean", "cereal_rye", [])
    assert full["status"] == "complete"
    term = next(s for s in full["steps"] if s["step"] == "termination")
    assert term["methods"] == ["roller_crimp"]
    no_crimp = eq.season_feasibility(["planter", "grain_drill", "sprayer"], "soybean",
                                     "cereal_rye", [])  # fmt: skip
    assert "roller_crimp" not in next(s for s in no_crimp["steps"]
                                      if s["step"] == "termination")["methods"]  # fmt: skip
    # no drill: broadcast only where a sourced rule allows it, else manual_check
    bc = eq.season_feasibility(["planter", "broadcast_seeder", "sprayer"], "soybean",
                               "crimson_clover", [_Rule(management_action="aerial_overseed")])  # fmt: skip
    seed = next(s for s in bc["steps"] if s["step"] == "cover_seeding")
    assert seed["method"] == "broadcast" and seed["rule_id"] == "r1" and bc["status"] == "complete"
    unsourced = eq.season_feasibility(["planter", "broadcast_seeder", "sprayer"], "soybean",
                                      "crimson_clover",
                                      [_Rule(management_action="aerial_overseed",
                                             origin="ai_suggested")])  # fmt: skip
    assert unsourced["status"] == "manual_check"
    nothing = eq.season_feasibility(["combine"], "soybean", "cereal_rye", [])
    assert {s["step"]: s["status"] for s in nothing["steps"]} == {
        "plant": "manual_check", "cover_seeding": "manual_check", "termination": "manual_check"}


def test_generator_reports_feasibility_from_field_equipment(api):
    body = {"location": {"latitude": 34.98, "longitude": -80.55},
            "field": {"field_id": "f1", "equipment": ["planter", "sprayer"]},
            "goals": {"constraints": {"seasons": 1}}}  # fmt: skip
    r = api.post("/v1/plans/generate", json=body).json()
    assert r["candidates"], r
    for c in r["candidates"]:
        f = c["feasibility"]
        covers = [s for s in f["seasons"] if any(x["step"] == "cover_seeding" for x in s["steps"])]
        for s in covers:  # no drill and no broadcast seeder: covers need a person to check
            assert s["status"] == "manual_check"
        if not covers:
            winter_grain = any(x.get("kind") == "winter_grain"
                               for s in f["seasons"] for x in s["steps"])
            assert f["status"] == ("manual_check" if winter_grain else "complete")
    plain = api.post("/v1/plans/generate", json={**body, "field": {"field_id": "f1"}}).json()
    assert {c["feasibility"]["status"] for c in plain["candidates"]} == {"unknown"}
    bad = api.post("/v1/plans/generate", json={**body, "field": {"equipment": ["jetpack"]}})
    assert bad.status_code == 400


@pytest.mark.parametrize("rule", [
    _Rule(management_action="seed_after_harvest", guidance="Do not broadcast"),
    _Rule(management_action="seed_after_harvest", guidance="Overseeding needs local confirmation"),
    _Rule(management_action="broadcast", review="manual_check"),
    _Rule(management_action="broadcast", suitability="avoid"),
])
def test_broadcast_needs_a_positive_unflagged_method_rule(rule):
    assert eq.broadcast_rule([rule]) is None


def test_generator_broadcast_does_not_borrow_coastal_or_cultivar_rules(api):
    body = {"location": {"latitude": 34.98, "longitude": -80.55},
            "field": {"equipment": ["planter", "broadcast_seeder", "sprayer"]},
            "goals": {"constraints": {"seasons": 1, "must_include": ["crimson_clover"]}}}
    result = api.post("/v1/plans/generate", json=body).json()
    assert result["candidates"]
    for candidate in result["candidates"]:
        for season in candidate["feasibility"]["seasons"]:
            for step in season["steps"]:
                if step["step"] == "cover_seeding":
                    assert step["status"] == "manual_check"


def test_winter_grain_needs_its_own_drill_check(api):
    result = api.post("/v1/plans/generate", json={
        "location": {"latitude": 34.98, "longitude": -80.55},
        "field": {"equipment": ["planter", "sprayer"]},
        "goals": {"constraints": {"seasons": 1, "must_include": ["winter_wheat"]}},
    }).json()
    assert result["candidates"]
    for candidate in result["candidates"]:
        assert candidate["feasibility"]["status"] == "manual_check"
        steps = candidate["feasibility"]["seasons"][0]["steps"]
        wheat = next(s for s in steps if s["crop_id"] == "winter_wheat")
        assert wheat["status"] == "manual_check" and wheat["equipment"] == []
