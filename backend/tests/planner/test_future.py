"""P3: the future multi-season farm plan. Offline; demo presets and SAGE only."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from acre.catalogs import regional

UNION = {"latitude": 34.98, "longitude": -80.55}
PERGAMINO = {"latitude": -33.89, "longitude": -60.57}
AS_OF = "2026-11-14"


@pytest.fixture(autouse=True)
def _offline(tmp_path, monkeypatch):
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    regional.clear_cache()
    yield
    regional.clear_cache()


@pytest.fixture(scope="module")
def client():
    from acre.api.app import create_app

    return TestClient(create_app())


def future(client, **body):
    r = client.post("/v1/plans/future", json={"as_of": AS_OF, **body})
    assert r.status_code == 200, r.text
    return r.json()


def window(season, kind):
    return next(w for w in season["windows"] if w["kind"] == kind)


def test_union_rye_plan_over_two_seasons_gives_real_dates_with_origins(client):
    j = future(client, plan_id="corn_soy__rye", start_season="2027", seasons=2)
    assert j["status"] == "complete" and j["dates_basis"] == "assumed"
    s1, s2 = j["seasons"]
    assert (s1["season"], s2["season"]) == ("2027", "2028")
    assert window(s1, "plant")["start"] == "2027-05-12"  # soybean
    assert window(s1, "cover_terminate")["start"] == "2027-04-30"
    assert window(s1, "harvest")["start"] == "2026-09-20"  # corn, before the rye
    assert window(s2, "harvest")["start"] == "2027-10-15"  # that soybean comes out
    assert window(s2, "plant")["start"] == "2028-04-15"  # corn
    for s in (s1, s2):
        for w in s["windows"]:
            want = {"pre_plant_check": "calculation",
                    "typical_planting_window": "dataset_estimate"}.get(w["kind"], "assumed")  # fmt: skip
            assert w["origin"] == want, w
        assert s["cover_schedule"]["crop_id"] == "cereal_rye"
        assert all(m["origin"] for m in s["milestones"])
        assert s["backup"] and s["decision_deadlines"]
        d = s["decision_deadlines"][0]
        assert d["next_check_date"] < d["date"] and d["switch_condition"]
    assert "not a forecast" in j["note"]


def test_rule_milestones_carry_the_rule_origin(client):
    j = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=1)
    checks = [m for m in j["seasons"][0]["milestones"] if m["kind"] == "check"]
    assert checks and {m["rule_origin"] for m in checks} == {"verified_source"}
    # a check's date is the plan date it falls on (assumed demo dates), never the rule's origin
    assert {m["origin"] for m in checks} <= {"assumed", "calculation"}


def test_moving_rye_termination_7_days_updates_milestones_deadline_and_diff(client):
    base = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=2)
    j = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=2,
               edits=[{"field": "winter.terminate", "season": 1, "shift_days": -7}])  # fmt: skip
    s1 = j["seasons"][0]
    assert window(s1, "cover_terminate")["start"] == "2027-04-23"
    assert window(s1, "cover_terminate")["origin"] == "grower"  # edited by the farmer
    term = next(m for m in s1["milestones"] if m["action_id"] == "terminate")
    assert term["date"] == "2027-04-23"
    before_dl = base["seasons"][0]["decision_deadlines"][0]["date"]
    assert s1["decision_deadlines"][0]["date"] != before_dl
    ch = j["diff"]["changes"]
    assert [c["season"] for c in ch] == ["2027"]  # the other season did not change
    moved = next(c for c in ch[0]["changes"] if c["action_id"] == "terminate")
    assert moved["days_moved"] == -7 and "winter.terminate" in moved["why"][0]
    assert ch[0]["decision_deadline"]["before"] == before_dl
    assert ch[0]["plan_edits"] == [{"field": "winter.terminate", "before": "04-30",
                                    "after": "04-23"}]  # fmt: skip
    assert j["recommendation_refresh"]["changed_plan_ids"] == ["corn_soy__rye"]


def test_swapping_the_cover_and_a_priority_edit(client):
    j = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=1,
               edits=[{"field": "winter.crop_id", "season": 1, "value": "crimson_clover"},
                      {"field": "priorities.soil_cover", "value": 3}])  # fmt: skip
    assert j["seasons"][0]["cover_schedule"]["crop_id"] == "crimson_clover"
    assert j["recommendation_refresh"]["priority_edits"] == {"soil_cover": 3}


def test_pergamino_plan_gives_southern_dates_crossing_the_year(client):
    gen = client.post("/v1/plans/generate", json={
        "location": PERGAMINO, "start_year": 2027,
        "goals": {"preferences": {"liked_crops": ["soybean", "maize"]}}}).json()  # fmt: skip
    cand = next(c for c in gen["candidates"] if c["crops"][:2] == ["maize", "soybean"])
    j = future(client, location=PERGAMINO, candidate=cand, start_season=2027, seasons=2)
    assert j["status"] == "complete" and j["catalog"]["region_key"] == "AR-B"
    s1 = j["seasons"][0]
    grow = window(s1, "growing_season")
    assert grow["start"].startswith("2027-1") and grow["end"].startswith("2028-0")  # Nov → Apr
    assert window(s1, "plant")["origin"] == "dataset_estimate"
    assert j["meta"]["catalog_version"].startswith("v3:AR-B:")


@pytest.mark.parametrize("body, field", [
    ({"plan_id": "nope"}, "plan_id"),
    ({"rotation_id": "nope"}, "rotation_id"),
    ({}, "plan"),
    ({"plan_id": "corn_soy__rye", "seasons": 11}, "seasons"),
    ({"plan_id": "corn_soy__rye", "start_season": "soon"}, "start_season"),
    ({"plan_id": "corn_soy__rye", "edits": [{"field": "next_crop_id", "value": "rice"}]},
     "edits[0].field"),
    ({"plan_id": "corn_soy__rye", "edits": [{"field": "winter.crop_id", "value": "quinoa_x"}]},
     "edits[0].value"),
])  # fmt: skip
def test_bad_input_is_a_typed_400(client, body, field):
    r = client.post("/v1/plans/future", json=body)
    assert r.status_code == 400 and r.json()["issues"][0]["field"].startswith(field)


def test_a_single_leg_that_cannot_repeat_is_rejected(client):
    plan = client.get("/v1/plans/wheat/template").json()["plan"]  # corn -> wheat -> soybean
    r = client.post("/v1/plans/future", json={"plan": plan, "start_season": 2027, "seasons": 2})
    assert r.status_code == 400 and r.json()["issues"][0]["code"] == "season_chain"


def test_rotation_id_lays_out_its_legs(client):
    j = future(client, rotation_id="add_grain_crop", start_season=2027, seasons=2)
    s1, s2 = j["seasons"]
    assert window(s1, "grain_harvest")["start"] == "2027-06-05"
    assert window(s1, "plant")["start"] == "2027-06-12"  # double-crop soybean
    assert window(s2, "harvest")["start"] == "2027-10-15"


def test_the_note_includes_the_future_plan_with_audit_ids(client):
    from acre.report.audit import verify

    r = client.post("/v1/plans/note", json={"plan_id": "corn_soy__rye", "year": 2027,
                                            "as_of": AS_OF, "future": {"seasons": 2}})  # fmt: skip
    j = r.json()
    assert r.status_code == 200 and j["status"] == "complete"
    fp = j["future_plan"]
    assert [s["season"] for s in fp["seasons"]] == ["2027", "2028"]
    days = fp["seasons"][0]["cover_schedule"]["living_cover_days"]
    assert days["audit_id"] in j["audit"]["entries"] and days["unit"] == "days"
    assert verify(j) == []
    bad = client.post("/v1/plans/note", json={"plan_id": "corn_soy__rye", "future": {"seasons": 0}})
    assert bad.status_code == 400


# --------------------------------------------------------------------------- review fixes (B-m2.md)


def test_an_edit_to_one_season_never_moves_a_repeated_leg(client):
    base = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=3)
    j = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=3,
               edits=[{"field": "winter.terminate", "season": 1, "shift_days": -7}])  # fmt: skip
    assert window(j["seasons"][0], "cover_terminate")["start"] == "2027-04-23"
    assert window(j["seasons"][2], "cover_terminate") == window(base["seasons"][2],
                                                                "cover_terminate")  # fmt: skip
    s3 = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=3,
                edits=[{"field": "winter.terminate", "season": 3, "shift_days": -7}])  # fmt: skip
    assert window(s3["seasons"][2], "cover_terminate")["start"] == "2029-04-23"


def test_leap_day_dates_can_be_moved(client):
    plan = client.post("/v1/plans/future", json={"plan_id": "corn_soy__rye"}).json()
    leg = plan["seasons"][0]["plan"]
    leg["winter"]["terminate"] = "02-29"
    r = client.post("/v1/plans/future", json={"plans": [leg], "start_season": 2028, "seasons": 1,
                                              "edits": [{"field": "winter.terminate",
                                                         "shift_days": 1}]})  # fmt: skip
    assert r.status_code == 200, r.text
    assert window(r.json()["seasons"][0], "cover_terminate")["start"] == "2028-03-01"


def test_moving_a_harvest_lists_the_dependent_growing_window(client):
    j = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=2,
               edits=[{"field": "prev_harvest", "season": 2, "shift_days": 5}])  # fmt: skip
    s1 = next(c for c in j["diff"]["changes"] if c["season"] == "2027")
    grow = next(w for w in s1["window_changes"] if w["kind"] == "growing_season")
    assert grow["before"][1] == "2027-10-15" and grow["after"][1] == "2027-10-20"


def test_the_last_season_harvest_comes_from_the_rotation_without_a_location(client):
    j = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=2)
    grow = window(j["seasons"][1], "growing_season")  # corn planted 2028, out in autumn 2028
    assert grow["start"] == "2028-04-15" and grow["end"] == "2028-09-20"
    assert grow["origin"] == "assumed"


def test_the_note_keeps_provenance_and_audits_each_season_against_its_own_plan(client):
    leg2 = client.post("/v1/plans/future", json={"plan_id": "soy_corn__rye"}).json()[
        "seasons"][0]["plan"]
    leg2["plan_id"] = "my_corn_leg"
    j = client.post("/v1/plans/note", json={"plan_id": "corn_soy__rye", "year": 2027,
                                            "future": {"seasons": 2, "plans": [leg2]}}).json()  # fmt: skip
    s1, s2 = j["future_plan"]["seasons"]
    assert window(s1, "plant")["origin"] == "assumed" and window(s2, "plant")["origin"] == "grower"
    a2 = j["audit"]["entries"][s2["cover_schedule"]["living_cover_days"]["audit_id"]]
    assert a2["source_ref"]["ref"] == "my_corn_leg" and a2["source_ref"]["season"] == "2028"


def test_historical_vulnerabilities_and_refresh_come_from_p2(client):
    pytest.importorskip("acre.compare.recommend")
    j = future(client, plan_id="corn_soy__rye", start_season=2027, seasons=2,
               edits=[{"field": "priorities.soil_cover", "value": 3}])  # fmt: skip
    ref = j["recommendation_refresh"]
    assert ref["status"] in ("complete", "partial", "insufficient_data", "unavailable")
    if ref["status"] != "unavailable":
        assert ref["method"]["shortlist"] == "pareto_non_dominated"
        vulns = [v for s in j["seasons"] for v in s["historical_vulnerabilities"]]
        assert all(v["year"] and v["indicator"] for v in vulns)


def test_feb_28_plus_one_is_feb_29_in_a_leap_year_and_bad_origins_are_rejected(client):
    leg = client.post("/v1/plans/future", json={"plan_id": "corn_soy__rye"}).json()[
        "seasons"][0]["plan"]
    leg["winter"]["terminate"] = "02-28"
    r = client.post("/v1/plans/future", json={"plans": [leg], "start_season": 2028, "seasons": 1,
                                              "edits": [{"field": "winter.terminate",
                                                         "shift_days": 1}]})  # fmt: skip
    assert window(r.json()["seasons"][0], "cover_terminate")["start"] == "2028-02-29"
    cand = {"seasons": [{"plan": leg, "origins": {"next_plant": "made_up"}}]}
    bad = client.post("/v1/plans/future", json={"candidate": cand, "seasons": 1})
    assert bad.status_code == 400 and bad.json()["issues"][0]["code"] == "invalid_origin"


def test_an_unknown_final_harvest_makes_the_season_and_plan_partial(client):
    leg = client.post("/v1/plans/future", json={"plan_id": "corn_soy__rye"}).json()[
        "seasons"][0]["plan"]
    j = client.post("/v1/plans/future", json={"plans": [leg], "start_season": 2027,
                                              "seasons": 1}).json()  # fmt: skip
    assert j["seasons"][0]["status"] == "partial" and j["seasons"][0]["harvest_known"] is False
    assert j["status"] == "partial"
