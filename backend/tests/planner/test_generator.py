"""P1: goals, constraints and the rotation generator. Offline; synthetic profile fixtures only."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from acre.catalogs import regional
from acre.planner.generator import MAX_CANDIDATES, generate_candidates
from acre.planner.goals import PRIORITY_IDS, Constraints, FieldContext, Goals
from acre.report.meta import get_index
from tests.catalogs.test_regional import V3_ROW, write_profile

UNION = {"latitude": 34.98, "longitude": -80.55}
PERGAMINO = {"latitude": -33.89, "longitude": -60.57}
YEAR = 2027
NC_RULE_IDS = set(get_index().rules)
SAMPLES = json.loads((Path(__file__).resolve().parents[2] / "data" / "samples" /
                      "union_plans.json").read_text())  # fmt: skip


@pytest.fixture(autouse=True)
def _offline(tmp_path, monkeypatch):
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    regional.clear_cache()
    yield
    regional.clear_cache()


def gen(location=UNION, goals: dict | None = None, field: dict | None = None):
    return generate_candidates(location, FieldContext.model_validate(field or {}),
                               Goals.model_validate(goals or {}), start_year=YEAR)  # fmt: skip


def legs(c) -> list[str]:
    return [s.plan.model_dump_json(exclude={"plan_id", "label", "region", "production_system"})
            for s in c.seasons]  # fmt: skip


def preset_legs(plan_id: str) -> str:
    from acre.contracts import Plan

    p = next(s["plan"] for s in SAMPLES["samples"] if s["plan_id"] == plan_id)
    return Plan.model_validate(p).model_dump_json(
        exclude={"plan_id", "label", "region", "production_system"})


# --------------------------------------------------------------------------- goals model


def test_priorities_default_and_validate():
    g = Goals()
    assert set(g.priorities) == set(PRIORITY_IDS)
    assert Goals.model_validate({"priorities": {"soil_cover": 3}}).priorities["crop_diversity"] == 0
    for bad in ({"soil_cover": 4}, {"soil_cover": -1}, {"made_up": 1}, {"soil_cover": True},
                {"soil_cover": 1.5}):  # fmt: skip
        with pytest.raises(ValidationError):
            Goals.model_validate({"priorities": bad})


def test_constraints_validate_crops_dates_and_consistency():
    c = Constraints.model_validate({"excluded_crops": ["field_corn"], "latest_planting": "06-15"})
    assert c.excluded_crops == ["maize"] and c.irrigation == "unknown"
    for bad in ({"excluded_crops": ["quinoa_x"]}, {"latest_planting": "6-15"},
                {"latest_planting": "02-30"}, {"seasons": 5}, {"seasons": 0},
                {"equipment": ["laser_weeder"]}, {"irrigation": "maybe"},
                {"must_include": ["soybean"], "excluded_crops": ["soybean"]},
                {"must_include": ["soybean"], "allowed_crops": ["maize"]}, {"surprise": 1}):  # fmt: skip
        with pytest.raises(ValidationError):
            Constraints.model_validate(bad)


def test_field_history_is_at_most_three_known_crops():
    assert FieldContext.model_validate({"crop_history": ["soybean", "field_corn"]}).crop_history == [
        "soybean", "maize"]
    with pytest.raises(ValidationError):
        FieldContext.model_validate({"crop_history": ["a", "b", "c", "d"]})
    with pytest.raises(ValidationError):
        FieldContext.model_validate({"crop_history": ["quinoa_x"]})


# --------------------------------------------------------------------------- acceptance


def test_union_defaults_generate_the_three_presets():
    r = gen()
    assert r.status == "complete" and 0 < len(r.candidates) <= MAX_CANDIDATES
    by_legs = {tuple(legs(c)): c for c in r.candidates}
    for rotation in SAMPLES["rotations"]:
        want = tuple(preset_legs(pid) for pid in rotation["legs"])
        assert want in by_legs, rotation["rotation_id"]
        assert by_legs[want].matches_rotation == rotation["rotation_id"]
    # the presets come first, and NC dates say they are assumed
    assert {c.matches_rotation for c in r.candidates[:3]} == {
        "current_practice", "winter_cover", "add_grain_crop"}
    assert all(s.origins["prev_harvest"] == "assumed" for c in r.candidates for s in c.seasons)


def test_excluding_soybean_removes_every_sequence_with_it():
    r = gen(goals={"constraints": {"excluded_crops": ["soybean"]}})
    assert r.candidates and all("soybean" not in c.crops for c in r.candidates)
    assert any(e.name == "excluded_crops" for e in r.generation_log)


def test_latest_planting_prunes_late_double_crops_and_logs_it():
    base = gen()
    assert any(s.plan.winter.kind == "winter_grain" for c in base.candidates for s in c.seasons)
    r = gen(goals={"constraints": {"latest_planting": "06-01"}})
    assert not any(s.plan.winter.kind == "winter_grain" for c in r.candidates for s in c.seasons)
    entry = next(e for e in r.generation_log if e.name == "latest_planting")
    assert entry.kind == "constraint" and entry.pruned >= 1 and "06-01" in entry.reason_text
    assert any("winter_wheat" in x for x in entry.examples)


def test_history_soybean_soybean_with_a_rule_against_more_soybean_drops_it(tmp_path):
    write_profile(tmp_path / "cache", rows=(V3_ROW,))  # avoid soybean after soybean (synthetic)
    hist = {"crop_history": ["soybean", "soybean"]}
    one = {"constraints": {"seasons": 1}}
    r = gen(PERGAMINO, goals=one, field=hist)
    assert r.candidates
    assert all(c.seasons[0].plan.previous_crop_id == "soybean" for c in r.candidates)
    assert all(c.seasons[0].plan.next_crop_id != "soybean" for c in r.candidates)  # no 3rd soy
    e = next(e for e in r.generation_log if e.name == "ar_b_t_01")
    assert e.kind == "rule" and e.pruned >= 1
    # without the rule the same sequence is generated
    regional.clear_cache()
    for p in (tmp_path / "cache" / "regions").rglob("crop_rules.csv"):
        p.unlink()
    r2 = gen(PERGAMINO, goals=one, field=hist)
    assert any(c.seasons[0].plan.next_crop_id == "soybean" for c in r2.candidates)


def test_a_place_without_sourced_calendars_is_insufficient_data():
    r = gen({"latitude": -80.0, "longitude": 0.0})  # Antarctic ice: no SAGE cell, no profile
    assert r.status == "insufficient_data" and r.candidates == [] and r.gaps


def test_pergamino_is_dated_for_the_southern_hemisphere_without_nc_rules():
    r = gen(PERGAMINO, goals={"preferences": {"liked_crops": ["soybean", "maize"]}})
    assert r.status == "complete" and r.region_key == "AR-B"
    soy = next(c for c in r.candidates if c.crops[:2] == ["maize", "soybean"])
    s1 = soy.seasons[0].plan
    assert s1.next_crop_id == "soybean" and s1.next_plant[:2] in ("10", "11", "12")
    assert s1.prev_harvest[:2] in ("03", "04", "05")  # maize harvested in the austral autumn
    assert soy.seasons[0].origins["next_plant"] == "dataset_estimate"
    for c in r.candidates:
        for s in c.seasons:
            assert not ({*s.flagged, *s.manual_check} & NC_RULE_IDS)
            assert "NC" not in (s.plan.region or "")


def test_output_is_identical_across_runs():
    a = gen(goals={"priorities": {"soil_cover": 3}}).model_dump(mode="json")
    regional.clear_cache()
    b = gen(goals={"priorities": {"soil_cover": 3}}).model_dump(mode="json")
    assert a == b


def test_caution_and_manual_check_stay_flagged_and_avoid_never_appears():
    r = gen()
    clover = [c for c in r.candidates if "crimson_clover" in c.crops]
    assert clover and any(c.checks_summary["flagged"] for c in clover)
    idx = regional.regional_catalog(UNION["latitude"], UNION["longitude"])
    from acre.planner.checker import check_plan

    for c in r.candidates:
        for s in c.seasons:
            res = check_plan(s.plan, idx, year=s.year)
            assert not [x for x in res.rules if x.flagged and x.verdict == "avoid"]


def test_must_include_and_seasons():
    r = gen(goals={"constraints": {"must_include": ["winter_wheat"], "seasons": 1}})
    assert r.candidates and all("winter_wheat" in c.crops and len(c.seasons) == 1
                                for c in r.candidates)  # fmt: skip
    r3 = gen(goals={"constraints": {"seasons": 3}})
    assert all(len(c.seasons) == 3 for c in r3.candidates)
    for c in r3.candidates:  # each season starts with the crop the last one planted
        for a, b in zip(c.seasons, c.seasons[1:], strict=False):
            assert a.plan.next_crop_id == b.plan.previous_crop_id
            assert b.year == a.year + 1


def test_unknown_irrigation_and_equipment_never_prune():
    base = gen()
    r = gen(goals={"constraints": {"irrigation": "unknown", "equipment": ["no_roller_crimper"]}})
    assert [c.candidate_id for c in r.candidates] == [c.candidate_id for c in base.candidates]
    assert any(e.name == "equipment:no_roller_crimper" and e.pruned == 0
               for e in r.generation_log)  # fmt: skip


def test_there_is_no_score_anywhere():
    blob = json.dumps(gen().model_dump(mode="json"))
    assert '"score' not in blob and "rank_score" not in blob


# --------------------------------------------------------------------------- HTTP


@pytest.fixture()
def client():
    from acre.api.app import create_app

    return TestClient(create_app())


def test_generate_route(client):
    body = {"location": UNION, "field": {"field_id": "fld_1", "area_ha": 40.0,
                                         "crop_history": ["field_corn"]},
            "goals": {"priorities": {"soil_cover": 3}, "constraints": {
                "excluded_crops": ["winter_wheat"], "latest_planting": "06-15", "seasons": 2}},
            "start_year": YEAR}  # fmt: skip
    r = client.post("/v1/plans/generate", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] == "complete" and j["candidates"]
    c = j["candidates"][0]
    for k in ("candidate_id", "seasons", "origins", "checks_summary", "previous_crop_id",
              "next_plant", "winter"):  # fmt: skip
        assert k in c
    assert c["previous_crop_id"] == "field_corn"
    assert all("winter_wheat" not in x["crops"] for x in j["candidates"])
    assert set(j["meta"]) >= {"plan_version", "catalog_version", "snapshot_hash", "request_id"}
    # a generated season is an ordinary Plan: the checker accepts it as is
    chk = client.post("/v1/plans/check", json={"plan": c["seasons"][0]["plan"], "year": YEAR})
    assert chk.status_code == 200 and chk.json()["result"]["status"] == "complete"


@pytest.mark.parametrize("body, field", [
    ({"goals": {"priorities": {"soil_cover": 9}}}, "goals.priorities"),
    ({"goals": {"constraints": {"excluded_crops": ["quinoa_x"]}}}, "goals.constraints"),
    ({"field": {"crop_history": ["quinoa_x"]}}, "field.crop_history"),
    ({"location": {"latitude": 200, "longitude": 0}}, "location"),
    ({"start_year": "soon"}, "start_year"),
])  # fmt: skip
def test_generate_route_rejects_bad_input_with_typed_issues(client, body, field):
    r = client.post("/v1/plans/generate", json=body)
    assert r.status_code == 400 and r.json()["status"] == "invalid_input"
    assert r.json()["issues"][0]["field"].startswith(field)


def test_generate_route_over_water_is_unsupported(client):
    j = client.post("/v1/plans/generate", json={"location": {"latitude": 0.0,
                                                             "longitude": -30.0}}).json()
    assert j["status"] == "unsupported" and j["candidates"] == []


# --------------------------------------------------------------------------- review fixes (P1.md)


def test_date_limits_are_read_in_the_year_of_the_date_they_limit():
    # Pergamino plants in Oct-Dec: a 1 April latest-planting date prunes every summer crop
    r = gen(PERGAMINO, goals={"constraints": {"latest_planting": "04-01", "seasons": 1}})
    assert r.candidates == [] and r.status == "partial"
    assert any(e.name == "latest_planting" and e.pruned for e in r.generation_log)
    # NC soybean is harvested in October: a 1 May earliest harvest prunes nothing
    assert len(gen(goals={"constraints": {"earliest_harvest": "05-01"}}).candidates) == len(
        gen().candidates)
    # 1 October prunes corn harvested on 20 September
    late = gen(goals={"constraints": {"earliest_harvest": "10-01"}})
    assert all(s.plan.prev_harvest != "09-20" for c in late.candidates for s in c.seasons)
    assert any(e.name == "earliest_harvest" for e in late.generation_log)


def test_seasons_chain_on_real_dates():
    from acre.planner.generator import chain_years
    from acre.seasons.align import build_calendar

    for loc in (UNION, PERGAMINO):
        for c in gen(loc, goals={"constraints": {"seasons": 3}}).candidates:
            cals = [build_calendar(s.plan, s.year) for s in c.seasons]
            for a, b in zip(cals, cals[1:], strict=False):
                assert a.plant < b.prev_harvest and (b.prev_harvest - a.plant).days <= 366
    from acre.contracts import Plan

    # a crop that would stay in the field for more than a year breaks the chain
    a = Plan(plan_id="a", previous_crop_id="soybean", prev_harvest="10-15",
             next_crop_id="maize", next_plant="04-15")  # fmt: skip
    b = Plan(plan_id="b", previous_crop_id="maize", prev_harvest="04-10",
             next_crop_id="soybean", next_plant="05-12")  # fmt: skip
    years, _ = chain_years([a, b], 2027)
    assert years == [2027, 2028]  # maize planted 2027-04-15, harvested 2028-04-10 (< 366 days)


def test_allowed_crops_also_limits_covers_and_winter_grains():
    r = gen(goals={"constraints": {"allowed_crops": ["maize", "soybean"]}})
    assert r.candidates and all(set(c.crops) <= {"maize", "soybean"} for c in r.candidates)


def test_leap_day_shift():
    from acre.planner.generator import _shift

    assert _shift("02-29", 1) == "03-01" and _shift("03-01", -1) == "02-28"
    assert _shift("03-01", -14) == "02-15"  # 14 days in a common year


def test_a_profile_seed_window_that_does_not_fit_keeps_assumed_provenance(tmp_path):
    write_profile(tmp_path / "cache", rows=(),
                  cover_crops=[{"crop_id": "cereal_rye", "origin": "ai_suggested",
                                "seed": {"start": "02-01", "end": "02-15"}, "sources": []}])  # fmt: skip
    r = gen(PERGAMINO, goals={"constraints": {"seasons": 1, "allowed_crops": [
        "maize", "soybean", "cereal_rye"]}})  # fmt: skip
    rye = [s for c in r.candidates for s in c.seasons if s.plan.winter.crop_id == "cereal_rye"]
    assert rye and all(s.origins["winter.seed"] == "assumed" for s in rye)


def test_unsourced_calendars_do_not_count_as_evidence(monkeypatch):
    import acre.planner.generator as g

    real = g.regional_catalog

    def unsourced(lat, lon):
        idx = real(lat, lon)
        idx.calendars = {k: {**v, "source": None} for k, v in idx.calendars.items()}
        return idx

    monkeypatch.setattr(g, "regional_catalog", unsourced)
    r = gen(PERGAMINO)
    assert r.status == "insufficient_data" and r.candidates == []


def test_pergamino_generate_meta_names_the_regional_catalog(client):
    j = client.post("/v1/plans/generate", json={"location": PERGAMINO, "start_year": YEAR}).json()
    assert j["meta"]["catalog_version"].startswith("v3:AR-B:") and j["meta"]["snapshot_hash"] is None


# --------------------------------------------------------------------------- review fixes (P1-r2.md)


def test_only_crops_with_sourced_calendars_are_generated(monkeypatch):
    import acre.planner.generator as g

    real = g.regional_catalog

    def strip_soy(lat, lon):
        idx = real(lat, lon)
        idx.calendars = {k: ({**v, "source": None} if k == "soybean" else v)
                         for k, v in idx.calendars.items()}  # fmt: skip
        return idx

    monkeypatch.setattr(g, "regional_catalog", strip_soy)
    r = gen(PERGAMINO, goals={"constraints": {"seasons": 1}})
    assert r.candidates and all("soybean" not in c.crops for c in r.candidates)
    assert any(e.name == "unsourced_calendars" for e in r.generation_log)


def test_cover_seed_dates_take_the_window_provenance_only_inside_it():
    from acre.planner.generator import _seed_in_window

    assert _seed_in_window("10-15", "04-15", "09-15", "11-15") == "10-22"  # open: a week later
    assert _seed_in_window("10-20", "05-12", "09-15", "10-15") is None  # closed before harvest
    assert _seed_in_window("09-20", "05-12", "10-01", "11-15") == "10-01"  # opens later
    r = gen()
    for c in r.candidates:
        for s in c.seasons:
            if s.origins.get("winter.seed") == "verified_source":
                src = s.sources["winter.seed"]
                assert src.get("rule_id")


def test_generator_checks_each_semantic_leg_and_year_once(monkeypatch):
    import acre.planner.generator as generator

    original = generator.check_plan
    seen = []

    def counted(plan, index, *, year):
        key = (plan.model_dump_json(exclude={"plan_id", "label"}), year)
        seen.append(key)
        return original(plan, index, year=year)

    monkeypatch.setattr(generator, "check_plan", counted)
    result = gen(goals={"constraints": {"seasons": 2}})
    assert result.candidates
    assert len(seen) == len(set(seen))
