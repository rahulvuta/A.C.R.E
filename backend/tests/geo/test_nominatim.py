import json

import httpx
import pytest

from acre.geo import nominatim
from acre.geo.nominatim import GeoError, Nominatim


def make(tmp_path, handler, **kw):
    calls: list[httpx.Request] = []

    def wrapped(request):
        calls.append(request)
        return handler(request)

    client = Nominatim(
        cache_dir=tmp_path / "c",
        client=httpx.Client(transport=httpx.MockTransport(wrapped)),
        min_interval=kw.pop("min_interval", 0.0),
        fixtures=kw.pop("fixtures", {"search": {}, "reverse": {}}),
        **kw,
    )
    return client, calls


def reply(payload, status=200):
    return lambda request: httpx.Response(status, json=payload)


ROW = {"lat": "-33.89", "lon": "-60.57", "display_name": "x", "address": {"country_code": "ar"}}


def test_search_sends_a_generic_user_agent_and_caches_the_answer(tmp_path):
    client, calls = make(tmp_path, reply([ROW]))
    assert client.search("Pergamino", 5) == [ROW]
    assert client.search("  pergamino ", 5) == [ROW]  # same question after normalising
    assert len(calls) == 1
    ua = calls[0].headers["user-agent"]
    assert ua == nominatim.USER_AGENT and "@" not in ua and "http" not in ua
    assert calls[0].url.params["format"] == "jsonv2" and calls[0].url.params["limit"] == "5"
    # the cache holds results, never the query text
    text = "".join(p.read_text() for p in (tmp_path / "c").glob("*.json"))
    assert "pergamino" not in text.lower().replace("display_name", "")


def test_reverse_rounds_the_point_before_sending_it(tmp_path):
    client, calls = make(tmp_path, reply({"address": {"country_code": "ar"}}))
    client.reverse(-33.8912345, -60.5687654)
    q = calls[0].url.params
    assert (q["lat"], q["lon"]) == ("-33.89", "-60.57")
    client.reverse(-33.8899, -60.5701)  # the same rounded point: no second request
    assert len(calls) == 1


def test_one_request_per_second(tmp_path):
    now = [100.0]
    slept: list[float] = []

    def sleep(s):
        slept.append(s)
        now[0] += s

    client, calls = make(
        tmp_path, reply([ROW]), min_interval=1.0, clock=lambda: now[0], sleep=sleep
    )
    client.search("a")
    now[0] += 0.25
    client.search("b")
    assert len(calls) == 2 and slept == [pytest.approx(0.75)]


def test_failures_are_typed_and_leave_no_cache(tmp_path):
    client, _ = make(tmp_path, reply({}, 503))
    with pytest.raises(GeoError) as e:
        client.search("x")
    assert e.value.code == "geocoder_unreachable"
    assert not list((tmp_path / "c").glob("*.json"))

    def boom(request):
        raise httpx.ConnectError("secret-query-text")

    client2, _ = make(tmp_path / "2", boom)
    with pytest.raises(GeoError) as e2:
        client2.search("secret-query-text")
    assert "secret-query-text" not in str(e2.value) + e2.value.detail

    client3, _ = make(tmp_path / "3", lambda r: httpx.Response(200, text="<html>"))
    with pytest.raises(GeoError) as e3:
        client3.reverse(1, 2)
    assert e3.value.code == "geocoder_bad_response"


def test_offline_uses_the_cache_and_fixtures_and_never_the_network(tmp_path):
    fixtures = {"search": {"pergamino": [ROW]}, "reverse": {"1.00,2.00": {"name": "fx"}}}
    client, calls = make(tmp_path, reply([ROW]), offline=lambda: True, fixtures=fixtures)
    assert client.search("Pergamino") == [ROW]
    assert client.reverse(1.001, 1.999) == {"name": "fx"}
    with pytest.raises(GeoError) as e:
        client.search("Somewhere else")
    assert e.value.code == "geocoder_offline"
    with pytest.raises(GeoError):
        client.reverse(40.0, 40.0)
    assert calls == []


def test_open_water_error_is_cached_as_no_result(tmp_path):
    client, calls = make(tmp_path, reply({"error": "Unable to geocode"}))
    assert client.reverse(0.0, -30.0) == {"error": "no_result"}
    client.reverse(0.0, -30.0)
    assert len(calls) == 1


def test_committed_fixtures_cover_the_demo_points():
    fx = nominatim.load_fixtures()
    for key in ("34.98,-80.55", "35.81,-80.87", "35.64,-80.53", "35.52,-78.37", "35.36,-77.99",
                "34.94,-77.93", "35.59,-77.37", "34.64,-79.10", "-33.89,-60.57"):  # fmt: skip
        assert key in fx["reverse"]
    assert "pergamino" in fx["search"]
    assert json.loads(nominatim.FIXTURES_PATH.read_text())["_note"].startswith("SYNTHETIC")


@pytest.mark.parametrize("payload", [[None], [1, 2], ["x"], {"a": 1}])
def test_malformed_search_rows_are_a_bad_response_and_not_cached(tmp_path, payload):
    client, _ = make(tmp_path, reply(payload))
    with pytest.raises(GeoError) as exc:
        client.search("Pergamino")
    assert exc.value.code == "geocoder_bad_response"
    assert not list((tmp_path / "c").rglob("*.json"))


# ------------------------------------------------------------------ settings (card 32)
def test_the_service_its_name_and_its_key_are_settings(tmp_path, monkeypatch):
    for name in (nominatim.URL_ENV, nominatim.USER_AGENT_ENV, nominatim.KEY_ENV,
                 nominatim.KEY_PARAM_ENV, nominatim.ATTRIBUTION_ENV,
                 nominatim.ATTRIBUTION_URL_ENV):  # fmt: skip
        monkeypatch.delenv(name, raising=False)
    plain = nominatim.from_settings()
    assert plain.base_url == nominatim.BASE_URL and plain.user_agent == nominatim.USER_AGENT
    assert "@" not in plain.user_agent and "http" not in plain.user_agent
    assert nominatim.attribution() == {"text": nominatim.ATTRIBUTION,
                                       "url": nominatim.ATTRIBUTION_URL}  # fmt: skip
    assert "OpenStreetMap" in nominatim.ATTRIBUTION

    monkeypatch.setenv(nominatim.URL_ENV, "https://geocode.example.org/v1/")
    monkeypatch.setenv(nominatim.USER_AGENT_ENV, "ExampleFarmSite/1.0 (https://farm.example.org)")
    monkeypatch.setenv(nominatim.KEY_ENV, "test-key-123")
    monkeypatch.setenv(nominatim.ATTRIBUTION_ENV, "Search by Example")
    set_up = nominatim.from_settings()
    assert set_up.base_url == "https://geocode.example.org/v1"
    assert nominatim.attribution() == {"text": "Search by Example", "url": ""}

    calls: list[httpx.Request] = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=[ROW])

    client = Nominatim(base_url=set_up.base_url, user_agent=set_up.user_agent, key="test-key-123",
                       cache_dir=tmp_path / "c", min_interval=0.0,
                       client=httpx.Client(transport=httpx.MockTransport(handler)),
                       fixtures={"search": {}, "reverse": {}})  # fmt: skip
    client.search("Pergamino", 5)
    assert str(calls[0].url).startswith("https://geocode.example.org/v1/search?")
    assert calls[0].url.params["key"] == "test-key-123"
    assert calls[0].headers["user-agent"] == "ExampleFarmSite/1.0 (https://farm.example.org)"
    # the key is sent, and kept nowhere
    assert "test-key-123" not in "".join(p.read_text() for p in (tmp_path / "c").glob("*.json"))

    monkeypatch.setenv(nominatim.URL_ENV, "not an address")
    assert nominatim.from_settings().base_url == nominatim.BASE_URL
