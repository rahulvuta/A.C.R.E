"""A2: location-generic analysis. POWER is mocked with the recorded Pergamino response."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from acre.field.location import in_nc_bounds
from acre.report.meta import get_index
from acre.weather import ondemand
from tests.weather.test_weather_ondemand import FIXTURE, FakePower

PERG = {"latitude": -33.89, "longitude": -60.57}
PERG_CELL = "cell_-34.000_-60.625"
PLAN = {
    "plan_id": "perg_soy", "previous_crop_id": "maize", "next_crop_id": "soybean",
    "prev_harvest": "04-20", "next_plant": "11-15",
    "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "05-01", "terminate": "10-20"},
}  # fmt: skip


@pytest.fixture(autouse=True)
def _cache(tmp_path, monkeypatch):
    monkeypatch.setenv(ondemand.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")  # analysis never fetches
    ondemand.reset_jobs()
    yield
    ondemand.set_fetch(None)
    ondemand.reset_jobs()


def _prepare(body: bytes | None = None, lat: float = PERG["latitude"],
             lon: float = PERG["longitude"]) -> ondemand.WeatherState:  # fmt: skip
    import os

    os.environ.pop("ACRE_OFFLINE", None)
    ondemand.set_fetch(FakePower(body=body))
    st = ondemand.prepare(ondemand.Cell.from_point(lat, lon), wait_s=30)
    os.environ["ACRE_OFFLINE"] = "1"
    assert st.job_status == "ready"
    return st


@pytest.fixture
def client() -> TestClient:
    from acre.api.app import create_app

    return TestClient(create_app())


def _compare(client: TestClient, location: dict[str, Any], plan: dict | None = None) -> dict:
    r = client.post("/v1/plans/compare", json={"plans": [plan or PLAN], "location": location,
                                               "include_soil": False})  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()


def _strings(obj: Any) -> set[str]:
    if isinstance(obj, dict):
        return set().union(*(_strings(v) for v in obj.values()), set(obj)) if obj else set()
    if isinstance(obj, list):
        return set().union(*(_strings(v) for v in obj)) if obj else set()
    return {obj} if isinstance(obj, str) else set()


NC_RULE_IDS = set(get_index().rules)
NC_CATALOG_VERSION = f"{get_index().version}:"


def test_pergamino_plan_runs_end_to_end(client):
    st = _prepare()
    body = _compare(client, PERG)
    p = body["plans"][0]
    assert p["status"] == "complete" and p["hemisphere"] == "south"
    assert p["winter"]["season_label"] == "Off-season (Apr–Nov)"
    assert p["spring"]["season_label"] == "30 days before planting"
    # the off-season window [04-20, 11-15) crosses June
    assert p["calendar"]["winter_days"] == 209
    assert p["calendar"]["spring_window"] == {"start": "10-16", "end": "11-14"}
    heavy = body["thresholds"]["heavy_rain"]
    assert heavy["method"] == "etccdi_r95p" and heavy["origin"] == "calculation"
    assert heavy["location"] == PERG_CELL and heavy["status"] == "complete"
    assert heavy["parameters"]["base_period"] == [1981, 2010]
    assert 20 < heavy["value"] < 76.2  # its own value, not NC's published 76.2 mm
    dry = body["thresholds"]["dry_spring"]["11-15"]
    assert dry["origin"] == "calculation" and dry["location"] == PERG_CELL
    assert dry["value"] is not None
    assert body["meta"]["snapshot_hash"] == st.snapshot_hash
    assert not body["meta"]["catalog_version"].startswith(NC_CATALOG_VERSION)
    assert p["catalog"] is not None  # the regional catalog state (B2), or "no_regional_catalog"
    assert p["coverage"]["cell_id"] == PERG_CELL and len(p["coverage"]["available_years"]) == 45
    assert {e["status"] for e in p["eras"].values()} <= {"complete", "insufficient_data"}
    assert body["weather_location"]["cell_id"] == PERG_CELL


def test_no_nc_rule_appears_in_a_pergamino_result(client):
    _prepare()
    body = _compare(client, PERG)
    assert not (_strings(body) & NC_RULE_IDS)
    assert body["data_sources"]["catalog"]["source"] != "Perplexity catalogs v1 (verbatim)"


def test_pergamino_replay_years_sensitivity(client):
    _prepare()
    r = client.post("/v1/seasons/2010/replay", json={"plan": PLAN, "location": PERG})
    rep = r.json()
    assert r.status_code == 200 and rep["hemisphere"] == "south"
    assert rep["dates"]["prev_harvest"] == "2010-04-20" and rep["dates"]["next_plant"] == "2010-11-15"
    assert rep["winter"]["season_label"] == "Off-season (Apr–Nov)"
    assert rep["thresholds"]["heavy_rain"]["method"] == "etccdi_r95p"
    assert rep["checks_triggered"] == []
    s = client.post("/v1/plans/sensitivity", json={"plan": PLAN, "location": PERG}).json()
    assert s["status"] == "unknown" and s["rule_ids"] == [] and s["check_id"] is None
    assert s["points"] and all(pt["checks_count"] is None for pt in s["points"])  # never 0
    assert all(pt["rain_outside_cover_mm_median"] is not None for pt in s["points"])
    y = client.post("/v1/years", json={"plan": PLAN, "location": PERG}).json()
    assert y["location"]["id"] == PERG_CELL and len(y["years"]) == 45
    g = client.get("/v1/years?lat=-33.89&lon=-60.57").json()  # lat/lon aliases
    assert g["location"]["id"] == PERG_CELL
    c = client.get(f"/v1/years?cell_id={PERG_CELL}").json()
    assert c["location"]["id"] == PERG_CELL
    assert not (_strings(rep) & NC_RULE_IDS) and not (_strings(s) & NC_RULE_IDS)


def test_compare_by_cell_id(client):
    _prepare()
    body = _compare(client, {"cell_id": PERG_CELL})
    assert body["plans"][0]["status"] == "complete"
    assert body["thresholds"]["heavy_rain"]["location"] == PERG_CELL


def test_unprepared_cell_outside_nc_is_unavailable_with_reason(client, monkeypatch):
    body = _compare(client, PERG)
    p = body["plans"][0]
    assert p["status"] == "unavailable" and p["reason"].startswith("offline_no_snapshot")
    assert body["weather_location"]["code"] == "offline_no_snapshot"
    assert body["meta"]["snapshot_hash"] is None
    monkeypatch.delenv("ACRE_OFFLINE")
    body = _compare(client, PERG)
    assert body["weather_location"]["code"] == "weather_not_prepared"
    assert body["weather_location"]["reason_text"]


def _trim_before(year: int) -> bytes:
    doc = json.loads(FIXTURE.read_bytes())
    for series in doc["properties"]["parameter"].values():
        for k in [k for k in series if int(k[:4]) < year]:
            del series[k]
    return json.dumps(doc).encode()


def test_short_record_gives_insufficient_data_for_the_era(client):
    st = _prepare(_trim_before(1995))
    # the calendar still starts 1981-01-01; 1981-1994 are missing days (blank, not zero)
    assert st.coverage["complete_years"] == 31 and st.coverage["status"] == "partial"
    assert st.coverage["missing_days"]["PRECTOTCORR"] > 5000
    body = _compare(client, PERG)
    p = body["plans"][0]
    dry = p["eras"]["dry_spring"]
    assert dry["status"] == "insufficient_data" and dry["result"] == "insufficient_data"
    assert dry["earlier"]["evaluable"] < 15 and dry["recent"]["evaluable"] == 20
    assert min(p["coverage"]["available_years"]) == 1995
    # 1981-2010 base is mostly missing: no local heavy-rain value, never a fake one
    heavy = body["thresholds"]["heavy_rain"]
    assert heavy["status"] == "insufficient_data" and heavy["value"] is None


def test_point_outside_nc_in_a_committed_nc_cell_uses_global_rules(client):
    lat, lon = 34.78, -80.6  # South Carolina, inside Union County's POWER cell
    assert not in_nc_bounds(lat, lon)
    body = _compare(client, {"latitude": lat, "longitude": lon})
    p = body["plans"][0]
    assert p["status"] == "complete"
    union_hash = "5ce131cfcd1f07d3738ecb9afaec6c3ef6a4764b6a3528bdd2b64debe7ba5f4e"
    assert body["meta"]["snapshot_hash"] == union_hash  # same weather series ...
    assert body["thresholds"]["heavy_rain"]["method"] == "etccdi_r95p"  # ... no NC rules
    assert p["winter"]["season_label"].startswith("Off-season")
    assert not (_strings(body) & NC_RULE_IDS)


def test_nc_compare_keeps_nc_values_and_adds_labels(client):
    body = _compare(client, {"latitude": 34.98, "longitude": -80.55},
                    {"plan_id": "x", "previous_crop_id": "field_corn", "next_crop_id": "soybean",
                     "prev_harvest": "10-15", "next_plant": "05-12",
                     "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "10-25",
                                "terminate": "04-20"}})  # fmt: skip
    p = body["plans"][0]
    heavy = body["thresholds"]["heavy_rain"]
    assert heavy["method"] == "published_fixed" and heavy["value"] == 76.2
    assert heavy["origin"] == "verified_source" and heavy["location"] == "cell_+35.000_-80.625"
    assert p["hemisphere"] == "north" and p["winter"]["season_label"] == "Winter"
    assert p["catalog"] is None and p["spring_checks"]


def test_threshold_set_id_ignores_the_labels():
    from acre.compare.context import get_context
    from acre.metrics.thresholds import build_threshold_set

    ctx = get_context()
    a = build_threshold_set(ctx.series, ctx.snapshot_hash, ["05-12"])
    b = build_threshold_set(ctx.series, ctx.snapshot_hash, ["05-12"], location="cell_x")
    assert a.threshold_set_id == b.threshold_set_id
    assert b.get("heavy_rain_mm").location == "cell_x"
