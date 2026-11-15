"""S6 uses synthetic farms and recorded calendars only; no network or grower data."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from acre.catalogs import sage
from acre.compare import engine
from acre.contracts import Plan
from acre.farms.geometry import parse_field
from acre.simulate.autofill import _midpoint
from acre.weather import ondemand
from tests.compare.test_global_analysis import _prepare

UNION = {"latitude": 34.98, "longitude": -80.55}
PERG = {"latitude": -33.89, "longitude": -60.57}
CROPS = [{"role": "previous", "crop_id": "field_corn"},
         {"role": "cover", "crop_id": "cereal_rye"}, {"role": "next", "crop_id": "soybean"}]


@pytest.fixture
def client(tmp_path, monkeypatch):
    from acre.api.app import create_app

    monkeypatch.setenv("ACRE_OFFLINE", "1")
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))
    ondemand.reset_jobs()
    yield TestClient(create_app())
    ondemand.reset_jobs()
    ondemand.set_fetch(None)


def _autofill(client, location=UNION, crops=CROPS):
    r = client.post("/v1/plans/autofill", json={"location": location, "crops": crops})
    assert r.status_code == 200, r.text
    out = r.json()
    return out, {d["field"]: d for d in out["dates"]}


def test_autofill_nc_sources_and_calendar(client):
    out, d = _autofill(client)
    assert out["plan"] is not None
    assert d["prev_harvest"]["origin"] == "dataset_estimate"
    assert d["next_plant"]["value"] == "05-05"
    assert d["next_plant"]["origin"] == "verified_source"
    assert d["next_plant"]["source"]["rule_id"] == "sb_pw_01"
    assert d["winter.seed"]["source"]["rule_id"] == "cr_pw_01"
    assert d["winter.terminate"]["source"]["rule_id"] == "cr_tt_03"
    cal = engine.build_calendar(Plan.model_validate(out["plan"]), 2027)
    assert cal.termination_gap_days == 14
    assert out["meta"]["snapshot_hash"] is None


def test_corn_uses_maximum_fourteen_day_termination_spacing(client):
    crops = [CROPS[1], {"role": "previous", "crop_id": "soybean"},
             {"role": "next", "crop_id": "field_corn"}]
    out, d = _autofill(client, crops=crops)
    assert d["next_plant"]["source"]["rule_id"] == "fc_pw_03"
    assert d["winter.terminate"]["source"]["rule_id"] == "cr_tt_01"
    assert engine.build_calendar(Plan.model_validate(out["plan"]), 2027).termination_gap_days == 14


def test_southern_calendar_needs_no_prepared_weather_or_nc_rules(client):
    out, d = _autofill(client, PERG)
    assert out["plan"] is not None
    assert d["next_plant"]["origin"] == "dataset_estimate"
    assert d["winter.seed"]["origin"] == "assumed"
    assert d["winter.terminate"]["origin"] == "assumed"
    assert all("rule_id" not in (v["source"] or {}) for v in d.values())
    assert engine.build_calendar(Plan.model_validate(out["plan"]), 2027).termination_gap_days == 14


def test_nc_piedmont_rules_do_not_reach_mountains(client):
    out, d = _autofill(client, {"latitude": 35.6, "longitude": -82.5})
    assert d["winter.seed"]["origin"] == "assumed"
    assert all((v["source"] or {}).get("rule_id") != "cr_pw_01" for v in d.values())


def test_midpoint_wraps_new_year():
    assert _midpoint("12-15", "01-15") == "12-30"


def test_harvest_clamps_cover_seeding_after_harvest(client, monkeypatch):
    original = sage.calendars_at

    def late_harvest(lat, lon):
        calendars, gaps = original(lat, lon)
        return [sage.CropCalendar(c.crop_id, c.name, c.plant,
                sage.Window("10-20", "10-20", "10-20") if c.crop_id == "maize" else c.harvest,
                c.cell) for c in calendars], gaps

    monkeypatch.setattr(sage, "calendars_at", late_harvest)
    out, d = _autofill(client)
    assert d["winter.seed"]["value"] == "10-27"
    assert d["winter.seed"]["origin"] == "calculation"
    assert out["status"] == "partial" and out["gaps"][0]["text"]
    assert engine.build_calendar(Plan.model_validate(out["plan"]), 2027).cover.seed.month == 10


def test_missing_calendar_leaves_null_dates_and_no_plan(client):
    out, d = _autofill(client, crops=[{"role": "previous", "crop_id": "missing_crop"}, CROPS[2]])
    assert out["plan"] is None and out["status"] == "partial"
    assert d["prev_harvest"]["value"] is None
    assert d["prev_harvest"]["status"] == "unavailable"
    assert out["gaps"][0]["reason"] == "no_calendar"


def test_chronology_conflict_returns_null_plan(client, monkeypatch):
    def short_window(*_):
        return [sage.CropCalendar("maize", "Corn", sage.Window("05-01", "05-01", "05-01"),
                sage.Window("04-30", "04-30", "04-30"), "synthetic")], []

    monkeypatch.setattr(sage, "calendars_at", short_window)
    out, _ = _autofill(client)
    assert out["plan"] is None
    assert any(g["reason"] in {"seed_after_planting", "terminate_before_harvest",
                              "terminate_not_after_seed"} for g in out["gaps"])


def test_sage_unavailable_is_gap(client, monkeypatch):
    def absent(*_):
        raise sage.SageUnavailable("test fixture unavailable")

    monkeypatch.setattr(sage, "calendars_at", absent)
    out, _ = _autofill(client)
    assert out["plan"] is None and out["gaps"]


@pytest.mark.parametrize("location,crops", [({}, CROPS), ({"latitude": 35}, CROPS),
    ({"cell_id": "bad"}, CROPS), ({**UNION, "cell_id": "cell_+35.000_-80.625"}, CROPS),
    (UNION, [CROPS[0], CROPS[0]]), (UNION, [CROPS[0], CROPS[1]])])
def test_autofill_invalid_inputs(client, location, crops):
    r = client.post("/v1/plans/autofill", json={"location": location, "crops": crops})
    assert r.status_code == 400
    assert r.json()["status"] == "invalid_input"


def test_cell_only_and_no_cover_are_supported(client):
    out, d = _autofill(client, {"cell_id": "cell_-34.000_-60.625"}, [CROPS[0], CROPS[2]])
    assert out["plan"]["winter"]["kind"] == "none"
    assert set(d) == {"prev_harvest", "next_plant"}


@pytest.mark.parametrize("scenario", ["union", "pergamino"])
def test_demo_farm_is_deterministic_synthetic_and_simulates(client, scenario):
    r = client.get(f"/v1/demo/farm?scenario={scenario}")
    assert r.status_code == 200
    out = r.json()
    other = client.get(f"/v1/demo/farm?scenario={scenario}").json()
    assert {k: v for k, v in out.items() if k != "meta"} == \
           {k: v for k, v in other.items() if k != "meta"}
    assert out["label"] == "Demo farm (example values)"
    assert out["synthetic"] and "not sourced" in out["economics_note"]
    assert "evidence-based outlook" in out["note"] and "forecast" not in out["note"]
    assert len(out["farm"]["fields"]) == 2
    if scenario == "pergamino":
        _prepare()
    for field in out["farm"]["fields"]:
        assert field["area_ha"] == pytest.approx(parse_field(field["geometry"]).area_ha, abs=.001)
        body = {"location": field["location"], "field": field,
                "economics": {"overrides": out["economics_overrides"],
                              "loss_assumptions": out["loss_assumptions"]},
                "goals": out["goals"], "years": 10, "runs": 50,
                "scenarios": [{"scenario_id": "current",
                               "rotation": out["current_plans"][field["field_id"]]}]}
        sim = client.post("/v1/scenarios/simulate", json=body)
        assert sim.status_code == 200, sim.text
        sc = sim.json()["scenarios"][0]
        assert sc["money_status"] == "complete", sc["money_gaps"]
        assert sc["totals"]["weather_link"].startswith("none:")


def test_demo_unknown_scenario_is_invalid(client):
    assert client.get("/v1/demo/farm?scenario=unknown").status_code == 400


@pytest.mark.parametrize("reading", [
    {"date": "2025-02-30", "kind": "rainfall_mm", "value": 0},
    {"date": "2025-04-02", "kind": "soil_moisture_vwc", "value": 23},
    {"date": "2025-04-02", "kind": "rainfall_mm"},
])
def test_simulate_uses_shared_reading_validation(client, reading):
    demo = client.get("/v1/demo/farm").json()
    field = demo["farm"]["fields"][0]
    r = client.post("/v1/scenarios/simulate", json={"location": UNION,
                   "field": {"readings": [reading]}, "scenarios": [{"scenario_id": "current",
                   "rotation": demo["current_plans"][field["field_id"]]}]})
    assert r.status_code == 400
