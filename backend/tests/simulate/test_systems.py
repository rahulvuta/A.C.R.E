"""Card 21 (rest): crops grown together, and ground that stays planted all year. Offline: the
committed Union County snapshot. Plans and money values are synthetic test inputs."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from acre.simulate import money, seasons
from acre.weather import ondemand
from tests.simulate.test_simulate import ECON, UNION, _plan

AREA_HA = 10.0
BEANS = {"price": {"value": 600, "unit": "USD/t"}, "yield": {"value": 0.5, "unit": "t/acre"},
         "costs": {"value": 60, "unit": "USD/acre"}}  # fmt: skip
ORCHARD = {"price": {"value": 900, "unit": "USD/t"}, "yield": {"value": 2.0, "unit": "t/ha"},
           "costs": {"value": 500, "unit": "USD/ha"}}  # fmt: skip


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv(ondemand.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    ondemand.reset_jobs()
    seasons.clear_cache()
    monkeypatch.setattr(money, "_library", lambda *a, **k: None)
    yield
    ondemand.reset_jobs()


@pytest.fixture
def client() -> TestClient:
    from acre.api.app import create_app

    return TestClient(create_app())


def _post(client, scenarios, overrides) -> Any:
    return client.post("/v1/scenarios/simulate", json={
        "location": UNION, "scenarios": scenarios, "years": 10, "runs": 200, "seed": 7,
        "start_season": "2027", "field": {"area_ha": AREA_HA},
        "economics": {"overrides": overrides}})  # fmt: skip


def _tree(pid="orchard", crop="pecan") -> dict[str, Any]:
    return {"plan_id": pid, "previous_crop_id": crop, "prev_harvest": "10-31",
            "winter": {"kind": "none"}, "next_crop_id": crop, "next_plant": "10-31"}  # fmt: skip


def test_a_crop_grown_together_is_sold_and_paid_for_in_the_same_season(client):
    leg = _plan("soy_corn__no_cover")  # this season's crop is field corn
    alone = {"scenario_id": "alone", "is_baseline": True, "rotation": [leg]}
    together = {"scenario_id": "together", "rotation": [leg],
                "systems": {leg["plan_id"]: {"companions": ["dry_beans"]}}}  # fmt: skip
    r = _post(client, [alone, together], {**ECON, "dry_beans": BEANS})
    assert r.status_code == 200, r.text
    a, b = r.json()["scenarios"]
    # the weather measures are the same plan's: a companion changes none of them
    for key in ("rain_on_bare_soil_mm_per_year", "dry_springs", "living_cover_days_per_year"):
        assert a["totals"][key] == b["totals"][key]
    acres = AREA_HA * 2.4710538146716534
    extra = (0.5 * 600 - 60) * acres * 10  # ten seasons of beans: sales less their costs
    assert b["totals"]["margin_10y"]["median"] - a["totals"]["margin_10y"]["median"] == pytest.approx(extra, rel=1e-3)
    assert b["timeline"][0]["companions"] == ["dry_beans"] and a["timeline"][0]["companions"] == []
    assert b["totals"]["crop_families_detail"].keys() >= {"dry_beans", "field_corn"}
    note = b["system_notes"][0]
    assert note["kind"] == "grown_together" and "soil cover is not worked out" in note["text"]
    assert a["system_notes"] == []
    # both crops are planted and harvested in the month-by-month calendar
    planted = [op["crop_id"] for m in b["monthly"]["months"] for op in m.get("operations", [])
               if op["kind"] == "plant"]  # fmt: skip
    assert "dry_beans" in planted and "field_corn" in planted


def test_a_companion_with_no_price_is_a_gap_not_a_guess(client):
    leg = _plan("soy_corn__no_cover")
    sc = {"scenario_id": "together", "is_baseline": True, "rotation": [leg],
          "systems": {leg["plan_id"]: {"companions": ["dry_beans"]}}}  # fmt: skip
    doc = _post(client, [sc], ECON).json()["scenarios"][0]
    assert doc["money_status"] != "complete" and doc["totals"].get("margin_10y") is None
    assert any("dry_beans" in g["text"] for g in doc["money_gaps"])


def test_ground_that_stays_planted_has_no_bare_soil_and_no_planting_time(client):
    sc = {"scenario_id": "orchard", "is_baseline": True, "rotation": [_tree()],
          "systems": {"orchard": {"ground": "permanent"}}}  # fmt: skip
    r = _post(client, [sc], {"pecan": ORCHARD})
    assert r.status_code == 200, r.text
    doc = r.json()
    s = doc["scenarios"][0]
    t = s["totals"]
    assert t["rain_on_bare_soil_mm_per_year"]["median"] == 0
    assert t["heavy_rain_days_on_bare_soil_per_year"]["median"] == 0
    assert t["dry_springs"]["median"] == 0 and t["living_cover_days_per_year"]["median"] == 365
    # the money is the grower's own numbers, the same in every run and every year
    m = t["margin_10y"]
    assert m["p10"] == m["median"] == m["p90"] == pytest.approx((2.0 * 900 - 500) * AREA_HA * 10)
    assert s["timeline"][0]["ground"] == "permanent" and s["timeline"][0]["crop_sequence"] == ["pecan"]
    note = s["system_notes"][0]
    assert note["kind"] == "permanent_ground" and "dry planting time do not apply" in note["text"]
    assert "Weather is not used to change its yield" in note["text"]
    # nothing is planted in the calendar, and nothing is flagged as a planting-time risk
    kinds = {op["kind"] for mth in s["monthly"]["months"] for op in mth.get("operations", [])}
    assert kinds == {"harvest"}
    assert not any(mth.get("risks") for mth in s["monthly"]["months"])
    # the calendar is the ten season years: costs through each year, the sale in its harvest month
    months = s["monthly"]["months"]
    assert len(months) == 120 and months[0]["month"].endswith("-01")
    year_cost = 500 * AREA_HA
    assert all(mth["costs"]["median"] == pytest.approx(year_cost / 12, abs=1) for mth in months)
    sold = [mth for mth in months if mth["revenue"]["median"] > 0]
    assert len(sold) == 10 and all(any(op["kind"] == "harvest" for op in mth["operations"])
                                   for mth in sold)  # fmt: skip
    assert months[-1]["cumulative_net"]["median"] == pytest.approx(m["median"], abs=12)
    assert "spread evenly" in s["monthly"]["timing_text"]
    # every past season can be replayed: permanent ground rules none out
    assert doc["method"]["pool_years"] >= 40


def test_grazed_pasture_has_no_money_lines(client):
    sc = {"scenario_id": "pasture", "is_baseline": True, "rotation": [_tree("grass", "pasture_grass")],
          "systems": {"grass": {"ground": "permanent", "sold": False}}}  # fmt: skip
    r = _post(client, [sc], {})
    assert r.status_code == 200, r.text
    s = r.json()["scenarios"][0]
    assert s["money_status"] == "unavailable"
    assert s["money_gaps"][0]["reason"] == "nothing_sold"
    assert s["totals"]["living_cover_days_per_year"]["median"] == 365
    note = s["system_notes"][0]["text"]
    assert "Nothing is sold from it" in note and "your own yield" not in note


def test_a_tree_crop_can_be_compared_with_a_yearly_plan_on_the_same_past_seasons(client):
    yearly = {"scenario_id": "current", "is_baseline": True,
              "rotation": [_plan("corn_soy__no_cover"), _plan("soy_corn__no_cover")]}  # fmt: skip
    tree = {"scenario_id": "orchard", "rotation": [_tree()],
            "systems": {"orchard": {"ground": "permanent"}}}  # fmt: skip
    doc = _post(client, [yearly, tree], {**ECON, "pecan": ORCHARD}).json()
    a, b = doc["scenarios"]
    assert a["totals"]["rain_on_bare_soil_mm_per_year"]["median"] > 0
    assert b["totals"]["rain_on_bare_soil_mm_per_year"]["median"] == 0
    assert a["replayed_seasons_sample"] == b["replayed_seasons_sample"]


@pytest.mark.parametrize(("systems", "code"), [
    ({"nope": {"companions": ["dry_beans"]}}, "unknown_plan"),
    ({"orchard": {"ground": "permanent", "companions": ["dry_beans"]}}, "permanent_with_companions"),
])  # fmt: skip
def test_bad_systems_are_typed_errors(client, systems, code):
    sc = {"scenario_id": "x", "is_baseline": True, "rotation": [_tree()], "systems": systems}
    r = _post(client, [sc], {})
    assert r.status_code == 400 and code in {i["code"] for i in r.json()["issues"]}


def test_permanent_ground_is_one_crop_and_companions_are_other_crops(client):
    two = {**_tree(), "next_crop_id": "soybean"}
    sc = {"scenario_id": "x", "is_baseline": True, "rotation": [two],
          "systems": {"orchard": {"ground": "permanent"}}}  # fmt: skip
    assert "permanent_leg_shape" in {i["code"] for i in _post(client, [sc], {}).json()["issues"]}
    leg = _plan("soy_corn__no_cover")
    same = {"scenario_id": "x", "is_baseline": True, "rotation": [leg],
            "systems": {leg["plan_id"]: {"companions": [leg["next_crop_id"]]}}}  # fmt: skip
    assert "companion_is_the_crop" in {i["code"] for i in _post(client, [same], {}).json()["issues"]}
    many = {"scenario_id": "x", "is_baseline": True, "rotation": [leg],
            "systems": {leg["plan_id"]: {"companions": ["a_crop", "b_crop", "c_crop", "d_crop"]}}}  # fmt: skip
    assert _post(client, [many], {}).status_code in (400, 422)


def test_a_request_with_no_systems_keeps_its_result_id(client):
    sc = {"scenario_id": "current", "is_baseline": True, "rotation": [_plan("corn_soy__no_cover")]}
    a = _post(client, [sc], ECON).json()["meta"]["plan_version"]
    b = _post(client, [{**sc, "systems": {}}], ECON).json()["meta"]["plan_version"]
    assert a == b and a.startswith("sim_")
