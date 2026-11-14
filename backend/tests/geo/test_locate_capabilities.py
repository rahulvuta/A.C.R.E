import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fieldshift.geo import capabilities_for, describe
from fieldshift.geo.routes import router

UNION = (34.98, -80.55)
PERGAMINO = (-33.89, -60.57)
NC_POINTS = {
    "union": (34.98, -80.55), "iredell": (35.81, -80.87), "rowan": (35.64, -80.53),
    "johnston": (35.52, -78.37), "wayne": (35.36, -77.99), "duplin": (34.94, -77.93),
    "pitt": (35.59, -77.37), "robeson": (34.64, -79.10),
}  # fmt: skip


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(router, prefix="/v1")
    return TestClient(app)


def test_pergamino_is_argentina_buenos_aires_cfa_south():
    d = describe(*PERGAMINO)
    assert d.status == "complete" and d.on_land and d.hemisphere == "south"
    assert d.place["country"] == "AR" and d.place["admin1"] == "AR-B"
    assert d.place["display"] == "Pergamino, Buenos Aires, Argentina"
    assert d.climate.koppen == "Cfa" and d.climate.origin == "dataset_estimate"
    assert d.region_keys == ["AR-B", "AR", "koppen:Cfa"] and d.nc_region is None and not d.in_nc
    assert d.cell_id and d.cell_id.startswith("cell_")


@pytest.mark.parametrize("name,point", sorted(NC_POINTS.items()))
def test_nc_points_need_no_network_and_keep_their_region(name, point):
    d = describe(*point)
    assert d.in_nc and d.status == "complete" and d.place["admin1"] == "US-NC"
    assert d.region_keys == ["US-NC", "US", "koppen:Cfa"]
    want = "Piedmont" if name in ("union", "iredell", "rowan") else "Coastal Plain"
    assert d.nc_region == want and d.hemisphere == "north"


def test_mid_ocean_is_unsupported_and_bad_input_is_invalid():
    for pt in [(0.0, -30.0), (28.0, -90.0)]:
        d = describe(*pt)
        assert d.status == "unsupported" and d.code == "unsupported_location"
        assert d.on_land is False and d.region_keys == []
    for pt in [(95, 0), (0, 181), (float("nan"), 0), (True, 0), ("x", 1)]:
        assert describe(*pt).status == "invalid_input"


def test_geocoder_down_is_partial_with_the_climate_key_only(_isolated_geocoder, monkeypatch):
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")
    d = describe(48.0, 11.0)  # Bavaria: not a fixture
    assert d.status == "partial" and d.reason == "geocoder_offline" and d.reason_text
    assert d.region_keys == ["koppen:Dfb"] and d.place["country"] is None
    assert d.climate.koppen == "Dfb"


def test_resolve_without_network_uses_fixtures_but_never_asks_nominatim():
    d = describe(*PERGAMINO, allow_network=False)
    assert d.place["admin1"] == "AR-B"
    unseen = describe(48.0, 11.0, allow_network=False)  # the autouse client fails on any request
    assert unseen.region_keys == ["koppen:Dfb"]


# ------------------------------------------------------------------ capabilities


def test_capabilities_for_union_nc():
    c = capabilities_for(*UNION)
    f = c["features"]
    assert c["status"] == "complete" and c["region_key"] == "US-NC"
    assert f["weather"]["status"] == "complete" and f["weather"]["source"] == "committed"
    assert f["weather"]["origin"] == "nasa_modeled"
    assert f["catalog"]["status"] == "complete" and f["catalog"]["origin"] == "verified_source"
    assert f["soil"]["provider"] == "usda_sda"
    assert f["live_weather"]["provider"] == "nws" and f["drought"]["provider"] == "usdm"
    assert f["tools"] == {"irrigation": "complete", "fertilizer": "complete"}


def test_all_eight_nc_points_have_committed_weather():
    for point in NC_POINTS.values():
        w = capabilities_for(*point)["features"]["weather"]
        assert w["status"] == "complete" and w["source"] == "committed"


def test_capabilities_for_pergamino():
    c = capabilities_for(*PERGAMINO)
    f = c["features"]
    assert c["region_key"] == "AR-B" and c["status"] == "complete"
    assert f["weather"]["status"] == "unavailable" and f["weather"]["reason"] == "not_prepared"
    assert f["catalog"] == {
        "status": "partial", "origin": "dataset_estimate", "region_key": "AR-B",
        "reason_text": f["catalog"]["reason_text"],
    }  # fmt: skip
    assert f["soil"] == {"status": "complete", "provider": "soilgrids", "resolution_m": 250,
                         "origin": "dataset_estimate"}  # fmt: skip
    assert f["live_weather"]["provider"] == "open_meteo"
    assert (
        f["drought"]["status"] == "unavailable"
        and f["drought"]["reason"] == "no_provider_for_region"
    )
    assert f["tools"]["irrigation"] == "complete"


def test_offline_weather_for_an_unstored_cell_is_unavailable(monkeypatch):
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")
    w = capabilities_for(*PERGAMINO)["features"]["weather"]
    assert w["status"] == "unavailable" and w["reason"] == "offline_no_snapshot"


def _fake_power(body: bytes | None = None, error: Exception | None = None):
    from datetime import UTC, datetime
    from pathlib import Path

    from fieldshift.weather.power_client import RawFetch

    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "power" / (
        "pergamino_cell_-34.000_-60.625.json"
    )

    def fetch(lat, lon, start, end, **kwargs):
        if error is not None:
            raise error
        return RawFetch(body=body or fixture.read_bytes(), url="https://power.invalid/?mocked=1",
                        params={}, status_code=200,
                        retrieved_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        elapsed_s=0.0)  # fmt: skip

    return fetch


@pytest.fixture()
def _weather_jobs():
    from fieldshift.weather import ondemand

    ondemand.reset_jobs()
    yield ondemand
    ondemand.set_fetch(None)
    ondemand.reset_jobs()


def test_weather_block_comes_from_a1_and_is_nasa_modeled(_weather_jobs):
    w = capabilities_for(*PERGAMINO)["features"]["weather"]
    assert w["status"] == "unavailable" and w["reason"] == "not_prepared"
    assert w["origin"] == "nasa_modeled" and w["cell_id"] == "cell_-34.000_-60.625"


def test_a_cached_cell_counts_as_stored(_weather_jobs):
    ondemand = _weather_jobs
    ondemand.set_fetch(_fake_power())
    st = ondemand.prepare(ondemand.Cell.from_point(*PERGAMINO), wait_s=30)
    assert st.job_status == "ready"
    w = capabilities_for(*PERGAMINO)["features"]["weather"]
    assert w["job_status"] == "ready" and w["source"] == "cache"
    assert w["status"] in ("complete", "partial")


def test_a_failed_fetch_shows_as_failed(_weather_jobs):
    from fieldshift.weather.power_client import PowerFetchError

    ondemand = _weather_jobs
    ondemand.set_fetch(_fake_power(error=PowerFetchError("boom")))
    ondemand.prepare(ondemand.Cell.from_point(*PERGAMINO), wait_s=30)
    w = capabilities_for(*PERGAMINO)["features"]["weather"]
    assert w["job_status"] == "failed" and w["status"] == "unavailable" and w["reason"]


def test_a_pending_fetch_shows_as_pending(_weather_jobs):
    import threading

    ondemand = _weather_jobs
    gate = threading.Event()
    inner = _fake_power()

    def slow(*a, **k):
        assert gate.wait(10)
        return inner(*a, **k)

    ondemand.set_fetch(slow)
    ondemand.prepare(ondemand.Cell.from_point(*PERGAMINO))
    try:
        w = capabilities_for(*PERGAMINO)["features"]["weather"]
        assert w["job_status"] == "pending" and w["status"] == "unknown"
    finally:
        gate.set()
        ondemand.reset_jobs()


def test_capabilities_for_water_is_unsupported_not_a_crash():
    c = capabilities_for(0.0, -30.0)
    assert (
        c["status"] == "unsupported"
        and c["code"] == "unsupported_location"
        and c["features"] is None
    )


def test_unknown_country_does_not_invent_a_drought_monitor(monkeypatch):
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")
    c = capabilities_for(48.0, 11.0)
    assert c["status"] == "partial" and c["region_key"] == "koppen:Dfb"
    assert c["features"]["drought"]["reason"] == "region_unknown"


# ------------------------------------------------------------------ routes


def test_search_route_parses_decimal_and_dms_to_the_same_point(client):
    a = client.get("/v1/geo/search", params={"q": "35.1, -80.5"}).json()
    b = client.get("/v1/geo/search", params={"q": "35°06'N 80°30'W"}).json()
    assert a["query_kind"] == b["query_kind"] == "coordinates"
    assert a["results"] == b["results"]
    assert (a["results"][0]["latitude"], a["results"][0]["longitude"]) == (35.1, -80.5)
    assert set(a["meta"]) >= {"plan_version", "catalog_version", "snapshot_hash", "request_id"}


def test_search_route_finds_a_place_and_rounds_coordinates(client):
    r = client.get("/v1/geo/search", params={"q": "Pergamino", "limit": "3"}).json()
    assert r["status"] == "complete" and r["query_kind"] == "text"
    top = r["results"][0]
    assert top["label"] == "Pergamino, Buenos Aires, Argentina" and top["source"] == "nominatim"
    assert (top["latitude"], top["longitude"]) == (-33.89, -60.57)
    assert len(top["bbox"]) == 4 and top["bbox"][0] < top["bbox"][2]


def test_search_route_errors_and_a_geocoder_that_is_down(client, monkeypatch):
    assert client.get("/v1/geo/search").status_code == 400
    bad = client.get("/v1/geo/search", params={"q": "x", "limit": "99"})
    assert bad.status_code == 400 and bad.json()["issues"][0]["field"] == "limit"
    coords = client.get("/v1/geo/search", params={"q": "95, 10"})
    assert coords.status_code == 400 and coords.json()["issues"][0]["code"] == "invalid_coordinates"
    assert client.get("/v1/geo/search", params={"q": "y" * 300}).status_code == 400
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")
    down = client.get("/v1/geo/search", params={"q": "Springfield"})
    assert down.status_code == 200
    body = down.json()
    assert body["status"] == "unavailable" and body["reason"] == "geocoder_offline"
    assert body["reason_text"] and body["results"] == []


def test_reverse_route_for_pergamino(client):
    r = client.get("/v1/geo/reverse", params={"lat": "-33.89", "lon": "-60.57"}).json()
    assert r["status"] == "complete" and r["hemisphere"] == "south" and r["on_land"] is True
    assert r["place"]["country"] == "AR" and r["place"]["admin1"] == "AR-B"
    assert r["place"]["country_name"] == "Argentina" and r["place"]["admin1_name"] == "Buenos Aires"
    assert r["climate"]["koppen"] == "Cfa" and r["climate"]["resolution_km"] > 0
    assert r["climate"]["origin"] == "dataset_estimate"
    assert r["region_keys"] == ["AR-B", "AR", "koppen:Cfa"] and r["nc_region"] is None


def test_reverse_route_nc_region_and_water_and_bad_input(client):
    nc = client.get("/v1/geo/reverse", params={"lat": "35.52", "lon": "-78.37"}).json()
    assert nc["nc_region"] == "Coastal Plain" and nc["place"]["admin1"] == "US-NC"
    sea = client.get("/v1/geo/reverse", params={"lat": "0", "lon": "-30"})
    assert sea.status_code == 200
    assert sea.json()["status"] == "unsupported" and sea.json()["code"] == "unsupported_location"
    for q in ({}, {"lat": "x", "lon": "1"}, {"lat": "95", "lon": "1"}, {"lat": "1", "lon": "nan"}):
        assert client.get("/v1/geo/reverse", params=q).status_code == 400


def test_capabilities_route(client):
    r = client.get("/v1/locations/capabilities", params={"lat": "34.98", "lon": "-80.55"}).json()
    assert r["region_key"] == "US-NC" and r["features"]["catalog"]["origin"] == "verified_source"
    p = client.get("/v1/locations/capabilities", params={"lat": "-33.89", "lon": "-60.57"}).json()
    assert p["region_key"] == "AR-B" and p["features"]["soil"]["provider"] == "soilgrids"
    sea = client.get("/v1/locations/capabilities", params={"lat": "0", "lon": "-30"}).json()
    assert sea["status"] == "unsupported" and sea["code"] == "unsupported_location"
    assert client.get("/v1/locations/capabilities").status_code == 400


def test_mistyped_coordinates_are_rejected_locally_never_sent_to_the_geocoder(client):
    # the autouse client fails any outbound request, so a 400 proves nothing was sent
    r = client.get("/v1/geo/search", params={"q": "35.1 80.5 1"})
    assert r.status_code == 400 and r.json()["issues"][0]["code"] == "invalid_coordinates"
    assert client.get("/v1/geo/search", params={"q": ".5, -80.123456"}).json()["query_kind"] == (
        "coordinates"
    )
    for q in ("(35.123456, -80.123456)", "[35.123456, -80.123456]", "(35.1, -80.5, 7)"):
        r = client.get("/v1/geo/search", params={"q": q})
        assert r.status_code in (200, 400)
        if r.status_code == 200:
            assert r.json()["query_kind"] == "coordinates"
            assert r.json()["results"][0]["latitude"] == 35.12


def test_resolve_rounds_coordinates_to_two_decimals():
    from fieldshift.field.location import resolve_location

    loc = resolve_location(34.987654, -80.551234)
    assert (loc.latitude, loc.longitude) == (34.99, -80.55)
    water = resolve_location(0.123456, -30.123456)
    assert water.status == "unsupported" and (water.latitude, water.longitude) == (0.12, -30.12)


def test_a_place_query_is_the_only_text_that_reaches_the_geocoder(tmp_path):
    import httpx

    from fieldshift.geo import nominatim

    seen: list[httpx.URL] = []

    def handler(request):
        seen.append(request.url)
        return httpx.Response(200, json=[])

    nominatim.set_client(
        nominatim.Nominatim(
            cache_dir=tmp_path / "g",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
            min_interval=0.0,
            fixtures={"search": {}, "reverse": {}},
        )
    )
    app = FastAPI()
    app.include_router(router, prefix="/v1")
    c = TestClient(app)
    c.get("/v1/geo/search", params={"q": "Rosario"})
    d = c.get("/v1/geo/reverse", params={"lat": "41.523456", "lon": "-91.654321"})
    assert d.status_code == 200
    reverse = [u for u in seen if u.path.endswith("/reverse")][0]
    assert (reverse.params["lat"], reverse.params["lon"]) == ("41.52", "-91.65")


def test_production_app_serves_the_geo_routes():
    """The geo routes reach the production app through the field router."""
    from fieldshift.api.app import create_app

    app = create_app()
    assert {"/v1/geo/search", "/v1/geo/reverse", "/v1/locations/capabilities"} <= set(
        app.openapi()["paths"]
    )
    c = TestClient(app)
    assert c.get("/v1/geo/search", params={"q": "35.1, -80.5"}).json()["query_kind"] == (
        "coordinates"
    )
    assert c.get("/v1/locations/capabilities", params={"lat": "0", "lon": "-30"}).json()[
        "status"
    ] == "unsupported"
    assert c.get("/v1/geo/reverse", params={"lat": "x", "lon": "0"}).status_code == 400
