"""B4: SoilGrids outside the U.S. (and as the U.S. fallback), Open-Meteo outside the U.S.

Every provider is mocked; a test fails if any real request is attempted.
"""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from fieldshift.field import live, openmeteo, soilgrids
from fieldshift.field import routes as field_routes
from fieldshift.field.soil import unavailable

PERGAMINO = (-33.89, -60.57)
UNION = (34.98, -80.55)

SG_BODY = {"properties": {"layers": [
    {"name": n, "unit_measure": {"d_factor": f}, "depths": [
        {"label": "0-5cm", "values": {"mean": v}}, {"label": "5-15cm", "values": {"mean": v}},
        {"label": "15-30cm", "values": {"mean": None if n == "soc" else v}}]}
    for n, f, v in (("clay", 10, 250), ("sand", 10, 300), ("silt", 10, 450), ("soc", 10, 180),
                    ("phh2o", 10, 62), ("bdod", 100, 130))]}}  # fmt: skip
OM_BODY = {"timezone": "America/Argentina/Buenos_Aires",
           "current": {"time": "2026-11-14T12:00", "temperature_2m": 24.1,
                       "relative_humidity_2m": 55, "precipitation": 0.0, "wind_speed_10m": 12.0},
           "current_units": {"temperature_2m": "°C", "precipitation": "mm"},
           "daily": {"time": [f"2026-11-{14 + i}" for i in range(7)],
                     "temperature_2m_max": [28.0] * 7, "temperature_2m_min": [15.0] * 7,
                     "precipitation_sum": [0.0, 3.2, 0.0, 0.0, 12.5, 0.0, 0.0]},
           "daily_units": {"precipitation_sum": "mm"}}  # fmt: skip


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDSHIFT_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")  # geocoder: fixtures only
    live.DEFAULT_CACHE.clear()
    yield
    live.DEFAULT_CACHE.clear()


class Recorder:
    def __init__(self, routes: dict[str, tuple[int, object]]):
        self.routes, self.hosts = routes, []

    def client(self) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            self.hosts.append(request.url.host)
            for host, (code, body) in self.routes.items():
                if request.url.host == host:
                    return httpx.Response(code, json=body)
            raise AssertionError(f"unexpected host {request.url.host}")

        return httpx.Client(transport=httpx.MockTransport(handler))


def test_soilgrids_values_are_converted_labelled_and_blank_stays_blank():
    rec = Recorder({"rest.isric.org": (200, SG_BODY)})
    r = soilgrids.get_soilgrids(*PERGAMINO, client=rec.client(), offline=False)
    assert r.status == "partial" and r.origin == "dataset_estimate" and r.resolution_m == 250
    by = {p.name: p for p in r.properties}
    assert by["clay"].values[0].value == 25.0 and by["clay"].unit == "%"
    assert by["ph_water"].values[0].value == 6.2 and by["bulk_density"].values[0].value == 1.3
    assert by["soc"].values[2].value is None  # missing is None, not 0
    assert "model estimate" in r.note.lower() and r.source["url"]


def test_soilgrids_caches_per_250m_cell_and_separates_neighbouring_cells():
    rec = Recorder({"rest.isric.org": (200, SG_BODY)})
    soilgrids.get_soilgrids(*PERGAMINO, client=rec.client(), offline=False)
    soilgrids.get_soilgrids(PERGAMINO[0] + 0.0001, PERGAMINO[1], client=rec.client(),
                            offline=False)  # same cell: from the cache  # fmt: skip
    assert len(rec.hosts) == 1
    far = soilgrids.get_soilgrids(PERGAMINO[0] + 0.01, PERGAMINO[1], client=rec.client(),
                                  offline=False)  # fmt: skip
    assert len(rec.hosts) == 2 and far.cell != soilgrids._cell_id(*soilgrids.cell_of(*PERGAMINO))


def test_soilgrids_down_is_unavailable_and_never_raises():
    rec = Recorder({"rest.isric.org": (503, {})})
    r = soilgrids.get_soilgrids(*PERGAMINO, client=rec.client(), offline=False)
    assert r.status == "unavailable" and r.reason == "soilgrids_error" and r.properties == []
    assert soilgrids.get_soilgrids(*PERGAMINO, offline=True).reason == "offline_no_soil"


def test_soilgrids_request_carries_only_the_cell_centre():
    seen = []

    def handler(request):
        seen.append(dict(request.url.params.multi_items()))
        return httpx.Response(200, json=SG_BODY)

    soilgrids.get_soilgrids(-33.891234, -60.571234, offline=False,
                            client=httpx.Client(transport=httpx.MockTransport(handler)))  # fmt: skip
    clat, clon = soilgrids.cell_of(-33.891234, -60.571234)
    assert seen[0]["lat"] == f"{clat:.4f}" and "891234" not in json.dumps(seen)


def test_open_meteo_is_context_and_never_calls_nws_or_usdm():
    rec = Recorder({"api.open-meteo.com": (200, OM_BODY)})
    out = openmeteo.get_open_meteo(*PERGAMINO, client=rec.client(), offline=False)
    assert rec.hosts == ["api.open-meteo.com"]
    assert out["provider"] == "open_meteo" and "never used" in out["note"]
    f = out["forecast"]
    assert f["status"] == "complete" and len(f["data"]["daily"]) == 7
    assert f["data"]["daily"][0]["precipitation_sum"] == 0.0  # a real 0 stays 0
    assert f["data"]["daily"][0]["precipitation_probability_max"] is None  # not sent: None
    assert out["drought"]["status"] == "unavailable" and out["alerts"]["status"] == "unavailable"


@pytest.fixture()
def client():
    from fieldshift.api.app import create_app

    return TestClient(create_app())


def test_non_us_routes_use_soilgrids_and_open_meteo_and_never_nws(client, monkeypatch):
    calls = []
    monkeypatch.setattr(field_routes, "get_soil", lambda *a, **k: calls.append("sda"))
    monkeypatch.setattr(field_routes, "get_live", lambda *a, **k: calls.append("nws"))
    monkeypatch.setattr(soilgrids, "get_soilgrids", lambda la, lo: soilgrids.SoilGridsResult(
        status="unavailable", reason="soilgrids_unreachable"))  # fmt: skip
    monkeypatch.setattr(openmeteo, "get_open_meteo", lambda la, lo: {"provider": "open_meteo"})
    s = client.get("/v1/soil", params={"lat": PERGAMINO[0], "lon": PERGAMINO[1]}).json()
    assert s["status"] == "complete" and s["provider"] is None
    assert s["soilgrids"]["status"] == "unavailable" and s["soilgrids"]["reason_text"]
    lv = client.get("/v1/live", params={"lat": PERGAMINO[0], "lon": PERGAMINO[1]}).json()
    assert lv["provider"] == "open_meteo"
    assert calls == []  # SDA, NWS and USDM were never called for Argentina


def test_us_soil_uses_sda_first_and_soilgrids_only_as_fallback(client, monkeypatch):
    from fieldshift.field.soil import SoilResult

    monkeypatch.setattr(field_routes, "get_soil", lambda la, lo: SoilResult(status="complete"))
    sg_calls = []
    monkeypatch.setattr(soilgrids, "get_soilgrids", lambda la, lo: sg_calls.append(1) or
                        soilgrids.SoilGridsResult(status="complete"))  # fmt: skip
    j = client.get("/v1/soil", params={"lat": UNION[0], "lon": UNION[1]}).json()
    assert j["provider"] == "usda_sda" and sg_calls == []
    monkeypatch.setattr(field_routes, "get_soil", lambda la, lo: unavailable("SDA timed out"))
    j = client.get("/v1/soil", params={"lat": UNION[0], "lon": UNION[1]}).json()
    assert j["provider"] == "soilgrids" and j["soil"]["status"] == "unavailable" and sg_calls


@pytest.mark.parametrize("body", [
    {"properties": {"layers": [{"name": "clay", "depths": [None]}]}},
    {"properties": {"layers": [{"name": "clay", "depths": "x"}]}},
])  # fmt: skip
def test_malformed_soilgrids_is_unavailable_not_a_crash(body):
    rec = Recorder({"rest.isric.org": (200, body)})
    r = soilgrids.get_soilgrids(*PERGAMINO, client=rec.client(), offline=False)
    assert r.status == "unavailable"


def test_soilgrids_with_only_some_properties_is_partial():
    only_clay = {"properties": {"layers": [SG_BODY["properties"]["layers"][0]]}}
    rec = Recorder({"rest.isric.org": (200, only_clay)})
    r = soilgrids.get_soilgrids(*PERGAMINO, client=rec.client(), offline=False)
    assert r.status == "partial" and {p.name for p in r.properties} >= {"sand", "ph_water"}


def test_an_empty_open_meteo_answer_is_unavailable():
    rec = Recorder({"api.open-meteo.com": (200, {"daily": {}})})
    out = openmeteo.get_open_meteo(*PERGAMINO, client=rec.client(), offline=False)
    assert out["forecast"]["status"] == "unavailable" and out["status"] == "unavailable"
