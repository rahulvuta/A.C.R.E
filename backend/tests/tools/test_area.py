"""B4: irrigation and fertilizer with a field area; metric outside the U.S."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from fieldshift.tools.routes import AC_PER_HA, KG_PER_LB

PER_ACRE_EXACT = 120 / 0.46  # Phase 11: 260.87 lb urea per acre for 120 lb N
URE = {"targets": {"n_lb_per_acre": 120}, "product": {"fertilizer_id": "urea_46_0_0"}}


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")
    monkeypatch.setenv("FIELDSHIFT_CACHE_DIR", str(tmp_path / "cache"))
    from fieldshift.api.app import create_app

    return TestClient(create_app())


def fert(client, **extra):
    r = client.post("/v1/fertilizer/calc", json={**URE, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_120_lb_n_urea_on_10_ha_in_both_unit_systems(client):
    us = fert(client, area_ha=10, units="us")
    acres = 10 * AC_PER_HA
    assert us["result"]["product_lb_per_acre"] == 260.9  # the Phase 11 per-acre value
    assert us["per_area"] == {"value": 260.9, "unit": "lb/ac", "origin": "calculation"}
    assert us["field_total"]["value"] == pytest.approx(PER_ACRE_EXACT * acres, abs=0.1)
    assert us["field_total"]["unit"] == "lb" and us["area"]["unit"] == "ac"
    m = fert(client, area_ha=10, units="metric")
    assert m["per_area"]["unit"] == "kg/ha"
    assert m["per_area"]["value"] == pytest.approx(PER_ACRE_EXACT * KG_PER_LB * AC_PER_HA, abs=0.1)
    assert m["field_total"]["value"] == pytest.approx(PER_ACRE_EXACT * acres * KG_PER_LB, abs=0.1)
    assert m["field_total"]["unit"] == "kg" and m["area"] == {
        "value": 10.0, "unit": "ha", "origin": "grower", "basis": "area_ha"}
    # the per-area rate does not depend on the area
    assert fert(client, area_ha=1, units="metric")["per_area"] == m["per_area"]


def test_without_an_area_only_per_area_values(client):
    j = fert(client)
    assert j["field_total"] is None and j["area"] is None and j["per_area"]["value"] == 260.9
    assert j["units"] == "us"


def test_metric_is_the_default_outside_the_us(client):
    j = fert(client, area_ha=10, location={"latitude": -33.89, "longitude": -60.57})
    assert j["units"] == "metric" and j["field_total"]["unit"] == "kg"
    assert fert(client, location={"latitude": 34.98, "longitude": -80.55})["units"] == "us"


def test_field_id_and_farm_use_the_backend_area(client):
    pytest.importorskip("fieldshift.farms.geometry")
    # a synthetic ~1 km x 1 km square (fixture, not a real field)
    ring = [[-60.57, -33.89], [-60.5592, -33.89], [-60.5592, -33.881], [-60.57, -33.881],
            [-60.57, -33.89]]  # fmt: skip
    farm = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"field_id": "fld_1"},
         "geometry": {"type": "Polygon", "coordinates": [ring]}}]}  # fmt: skip
    j = fert(client, field_id="fld_1", farm=farm, units="metric")
    assert j["area"]["origin"] == "calculation" and 90 < j["area"]["value"] < 110
    assert j["field_total"]["value"] == pytest.approx(
        j["per_area"]["value"] * j["area"]["value"], rel=1e-3)


@pytest.mark.parametrize("extra, field", [
    ({"area_ha": 0}, "area_ha"), ({"area_ha": -1}, "area_ha"), ({"area_ha": True}, "area_ha"),
    ({"area_ha": 10, "area_acres": 5}, "area_acres"), ({"units": "imperial"}, "units"),
    ({"field_id": "x"}, "farm"),
    ({"field_id": "x", "farm": {"type": "FeatureCollection", "features": []}}, "field_id"),
])  # fmt: skip
def test_bad_area_input_is_a_typed_400(client, extra, field):
    r = client.post("/v1/fertilizer/calc", json={**URE, **extra})
    assert r.status_code == 400 and r.json()["issues"][0]["field"] == field


def test_irrigation_field_total_from_the_unmet_demand(client):
    # corn pollination uses 0.25 in/day; 1.0 in stored and 10 dry days leave 1.5 in unmet
    body = {"crop_id": "field_corn", "stage": "pollination", "awc_in": 2.0,
            "start_storage_in": 1.0, "irrigation": [],
            "weather": [{"date": f"2025-07-{d:02d}", "precip_mm": 0.0} for d in range(1, 11)]}  # fmt: skip
    j = client.post("/v1/irrigation/check", json={**body, "area_ha": 10, "units": "metric"}).json()
    need = j["result"]["supplemental_need"]["unmet_demand_in"]
    assert j["result"]["status"] == "complete" and need == pytest.approx(1.5)
    assert j["per_area"]["unit"] == "mm" and j["per_area"]["value"] == round(need * 25.4, 1)
    assert j["field_total"]["unit"] == "m3"
    assert j["field_total"]["value"] == pytest.approx(need * 25.4 * 10 * 10, abs=0.2)
    us = client.post("/v1/irrigation/check", json={**body, "area_ha": 10, "units": "us"}).json()
    assert us["field_total"]["unit"] == "acre_in"
    assert us["field_total"]["value"] == pytest.approx(need * 10 * AC_PER_HA, abs=0.01)
    plain = client.post("/v1/irrigation/check", json=body).json()
    assert plain["field_total"] is None and plain["per_area"]["unit"] == "in"


def test_tools_outside_nc_never_use_nc_rules(client):
    j = fert(client, location={"latitude": -33.89, "longitude": -60.57})
    assert j["result"]["n_reference"] is None  # NC's fc_nut_01 range is not shown in Argentina
    body = {"crop_id": "maize", "stage": "pollination", "awc_in": 2.0, "start_storage_in": 1.0,
            "irrigation": [], "weather": [{"date": "2025-01-01", "precip_mm": 0.0}],
            "location": {"latitude": -33.89, "longitude": -60.57}}  # fmt: skip
    r = client.post("/v1/irrigation/check", json=body).json()["result"]
    assert r["status"] in ("insufficient_data", "unsupported") and r["water_balance"] is None
    assert not r.get("stage_checks")


def test_field_id_accepts_the_contract_farm_shape(client):
    pytest.importorskip("fieldshift.farms.geometry")
    ring = [[-60.57, -33.89], [-60.5592, -33.89], [-60.5592, -33.881], [-60.57, -33.881],
            [-60.57, -33.89]]  # fmt: skip
    farm = {"farm_id": "f1", "fields": [{"field_id": "fld_1", "geometry": {
        "type": "Polygon", "coordinates": [ring]}}]}  # fmt: skip
    j = fert(client, field_id="fld_1", farm=farm, units="metric")
    assert j["area"]["origin"] == "calculation" and 90 < j["area"]["value"] < 110
