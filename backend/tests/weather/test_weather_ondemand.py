"""A1: weather for any grid cell on demand. POWER is always mocked; no network."""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from acre.weather import ondemand
from acre.weather.locations import PLACES, get_index
from acre.weather.power_client import OfflineError, PowerFetchError, RawFetch, is_offline

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "power" / (
    "pergamino_cell_-34.000_-60.625.json"
)
PERGAMINO = (-33.89, -60.57)
PERGAMINO_CELL = "cell_-34.000_-60.625"


class FakePower:
    """Records calls; returns the recorded Pergamino response (or raises)."""

    def __init__(self, body: bytes | None = None, error: Exception | None = None,
                 gate: threading.Event | None = None) -> None:  # fmt: skip
        self.body = body if body is not None else FIXTURE.read_bytes()
        self.error = error
        self.gate = gate
        self.calls: list[tuple[float, float, str, str]] = []
        self.lock = threading.Lock()

    def __call__(self, lat, lon, start, end, **kwargs):
        with self.lock:
            self.calls.append((lat, lon, start, end))
        if self.gate is not None:
            assert self.gate.wait(10)
        if self.error is not None:
            raise self.error
        if is_offline():
            raise OfflineError("offline")
        return RawFetch(body=self.body, url="https://power.larc.nasa.gov/api/temporal/daily/point"
                        "?mocked=1", params={}, status_code=200,
                        retrieved_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        elapsed_s=0.0)  # fmt: skip


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv(ondemand.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.delenv("ACRE_OFFLINE", raising=False)
    ondemand.reset_jobs()
    yield
    ondemand.set_fetch(None)
    ondemand.reset_jobs()


def _cell(lat=PERGAMINO[0], lon=PERGAMINO[1]) -> ondemand.Cell:
    return ondemand.Cell.from_point(lat, lon)


def _files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*")) if root.exists() else []


# --------------------------------------------------------------------------- cells


def test_pergamino_point_maps_to_its_cell_and_back():
    c = _cell()
    assert c.cell_id == PERGAMINO_CELL
    assert (c.center_latitude, c.center_longitude) == (-34.0, -60.625)
    assert ondemand.Cell.parse(PERGAMINO_CELL) == c


@pytest.mark.parametrize("bad", ["", "lat-34.00_lon-60.625", "cell_-34.100_-60.625",
                                 "cell_-34.000_-60.600", "cell_+91.000_+0.000",
                                 "cell_+0.000_+180.000"])  # fmt: skip
def test_bad_cell_ids_are_rejected(bad):
    with pytest.raises(ondemand.CellIdError):
        ondemand.Cell.parse(bad)


def test_antimeridian_cell_wraps_to_minus_180():
    assert _cell(10.0, 179.9).cell_id == "cell_+10.000_-180.000"


# --------------------------------------------------------------------------- prepare


def test_first_prepare_fetches_and_caches_second_reuses_same_hash():
    fake = FakePower()
    ondemand.set_fetch(fake)
    first = ondemand.prepare(_cell(), wait_s=30)
    assert first.job_status == "ready" and first.source == "fetched"
    assert len(fake.calls) == 1
    lat, lon, start, _end = fake.calls[0]
    assert (lat, lon, start) == (-34.0, -60.625, "1981-01-01")  # the cell centre, not the farm
    second = ondemand.prepare(_cell(-33.8, -60.4), wait_s=30)  # another point in the same cell
    assert second.job_status == "ready" and second.source == "cache"
    assert second.snapshot_hash == first.snapshot_hash
    assert len(fake.calls) == 1  # no second network call


def test_cache_layout_manifest_and_pointer(tmp_path):
    ondemand.set_fetch(FakePower())
    st = ondemand.prepare(_cell(), wait_s=30)
    base = tmp_path / "cache" / "weather" / PERGAMINO_CELL
    current = json.loads((base / "current.json").read_text())
    assert current["snapshot_hash"] == st.snapshot_hash
    assert current["source_url"].startswith("https://power.larc.nasa.gov/")
    assert current["retrieved_at"].endswith("Z")
    assert current["last_complete_day"] == "2026-11-11"  # 2026-11-12 is POWER fill
    manifest = json.loads((base / st.snapshot_hash / "manifest.json").read_text())
    assert manifest["hashes"]["snapshot_hash"] == st.snapshot_hash
    assert manifest["reference_point"]["id"] == PERGAMINO_CELL
    assert manifest["coverage"]["last_date"] == "2026-11-11"
    assert not [p for p in base.iterdir() if p.name.startswith(".tmp")]


def test_coverage_for_the_recorded_pergamino_cell():
    ondemand.set_fetch(FakePower())
    st = ondemand.prepare(_cell(), wait_s=30)
    cov = st.coverage
    assert cov["first_date"] == "1981-01-01" and cov["last_date"] == "2026-11-11"
    assert cov["complete_years"] == 45  # 1981-2025; 2026 is not over
    assert cov["status"] == "complete" and st.status == "complete"
    assert set(cov["missing_days"]) == {"PRECTOTCORR", "T2M_MAX", "T2M_MIN", "T2M", "GWETTOP",
                                        "GWETROOT"}  # fmt: skip
    assert cov["complete_pre_plant_windows"] is None  # plan-dependent: never a fake 0


def test_two_concurrent_prepares_cause_one_fetch():
    gate = threading.Event()
    fake = FakePower(gate=gate)
    ondemand.set_fetch(fake)
    results: list[ondemand.WeatherState] = []

    def go():
        results.append(ondemand.prepare(_cell(), wait_s=30))

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    pending = ondemand.current(_cell())
    assert pending.job_status == "pending"
    gate.set()
    for t in threads:
        t.join(15)
    assert len(fake.calls) == 1
    assert {r.job_status for r in results} == {"ready"}
    assert len({r.snapshot_hash for r in results}) == 1


def test_prepare_without_wait_returns_pending_with_poll_url():
    gate = threading.Event()
    ondemand.set_fetch(FakePower(gate=gate))
    st = ondemand.prepare(_cell())
    body = st.public()
    assert body["job_status"] == "pending" and body["poll"] == f"/v1/weather/{PERGAMINO_CELL}"
    assert body["snapshot_hash"] is None and body["coverage"] is None
    gate.set()
    ondemand._JOBS[PERGAMINO_CELL].future.result(15)
    assert ondemand.current(_cell()).job_status == "ready"


@pytest.mark.parametrize("error,reason", [
    (PowerFetchError("POWER fetch failed after 2 attempts: HTTP 503"), "power_unreachable"),
    (PowerFetchError("HTTP 422: bad start"), "power_error"),
    (TimeoutError("read timed out"), "power_unreachable"),
])  # fmt: skip
def test_power_down_is_unavailable_and_leaves_no_files(tmp_path, error, reason):
    ondemand.set_fetch(FakePower(error=error))
    st = ondemand.prepare(_cell(), wait_s=30)
    body = st.public()
    assert body["job_status"] == "failed" and body["status"] == "unavailable"
    assert body["reason"] == reason and body["reason_text"]
    assert _files(tmp_path / "cache" / "weather" / PERGAMINO_CELL) == []
    assert ondemand.current(_cell()).reason == reason  # GET reports the failure


def test_bad_power_payload_is_unavailable_and_leaves_no_files(tmp_path):
    ondemand.set_fetch(FakePower(body=b'{"not": "power"}'))
    st = ondemand.prepare(_cell(), wait_s=30)
    assert st.reason == "power_bad_response" and st.status == "unavailable"
    assert _files(tmp_path / "cache" / "weather" / PERGAMINO_CELL) == []


def test_write_failure_midway_leaves_no_partial_files(tmp_path, monkeypatch):
    ondemand.set_fetch(FakePower())

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(ondemand, "_write_json_atomic", boom)
    st = ondemand.prepare(_cell(), wait_s=30)
    assert st.reason == "cache_write_failed"
    assert [f for f in _files(tmp_path / "cache" / "weather" / PERGAMINO_CELL)] == []


def test_offline_with_no_cache_is_offline_no_snapshot(monkeypatch):
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    fake = FakePower()
    ondemand.set_fetch(fake)
    st = ondemand.prepare(_cell(), wait_s=5)
    assert (st.job_status, st.status, st.reason) == ("failed", "unavailable",
                                                     "offline_no_snapshot")  # fmt: skip
    assert fake.calls == []
    assert ondemand.current(_cell()).reason == "offline_no_snapshot"


def test_offline_serves_a_cached_cell(monkeypatch):
    ondemand.set_fetch(FakePower())
    first = ondemand.prepare(_cell(), wait_s=30)
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    ondemand.reset_jobs()
    again = ondemand.prepare(_cell(), refresh=True)
    assert again.job_status == "ready" and again.snapshot_hash == first.snapshot_hash
    assert again.notes  # says the refresh was skipped


def test_refresh_writes_a_new_hash_and_keeps_the_old_snapshot(tmp_path):
    ondemand.set_fetch(FakePower())
    first = ondemand.prepare(_cell(), wait_s=30)
    old_dir = tmp_path / "cache" / "weather" / PERGAMINO_CELL / first.snapshot_hash
    old_files = {p: p.read_bytes() for p in old_dir.rglob("*") if p.is_file()}
    # POWER revised one day: a different response body.
    body = json.loads(FIXTURE.read_bytes())
    body["properties"]["parameter"]["PRECTOTCORR"]["20250101"] = 12.34
    fake = FakePower(body=json.dumps(body).encode())
    ondemand.set_fetch(fake)
    no_refresh = ondemand.prepare(_cell(), wait_s=30)
    assert no_refresh.snapshot_hash == first.snapshot_hash and fake.calls == []  # never silent
    refreshed = ondemand.prepare(_cell(), refresh=True, wait_s=30)
    assert len(fake.calls) == 1
    assert refreshed.snapshot_hash != first.snapshot_hash
    assert {p: p.read_bytes() for p in old_dir.rglob("*") if p.is_file()} == old_files
    current = json.loads((old_dir.parent / "current.json").read_text())
    assert current["snapshot_hash"] == refreshed.snapshot_hash
    assert current["history"][0]["snapshot_hash"] == first.snapshot_hash


@pytest.mark.parametrize("place", PLACES, ids=lambda p: p.id)
def test_the_nc_snapshots_resolve_without_the_cache(place, tmp_path, monkeypatch):
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    fake = FakePower()
    ondemand.set_fetch(fake)
    st = ondemand.prepare(_cell(place.latitude, place.longitude), refresh=True)
    entry = get_index().by_id(place.id)
    assert st.job_status == "ready" and st.source == "committed"
    assert st.snapshot_hash == entry.snapshot_hash
    assert st.coverage["status"] == "complete"  # 1981-2024 = 44 complete years
    assert fake.calls == [] and _files(tmp_path / "cache") == []


def test_last_requestable_day_is_yesterday_utc():
    from datetime import date

    assert ondemand.last_requestable_day(date(2026, 3, 1)) == "2026-02-28"


# --------------------------------------------------------------------------- API


@pytest.fixture
def client():
    from acre.api.app import create_app

    return TestClient(create_app())


def test_api_prepare_then_get(client):
    ondemand.set_fetch(FakePower())
    r = client.post("/v1/weather/prepare",
                    json={"location": {"latitude": PERGAMINO[0], "longitude": PERGAMINO[1]},
                          "wait_s": 30})  # fmt: skip
    assert r.status_code == 200
    body = r.json()
    assert body["job_status"] == "ready" and body["source"] == "fetched"
    assert body["meta"]["snapshot_hash"] == body["snapshot_hash"]
    assert body["cell"]["center"] == {"latitude": -34.0, "longitude": -60.625}
    assert "-33.89" not in r.text and "-60.57" not in r.text  # the point is never echoed
    g = client.get(f"/v1/weather/{PERGAMINO_CELL}")
    assert g.status_code == 200 and g.json()["source"] == "cache"
    assert g.json()["snapshot_hash"] == body["snapshot_hash"]


def test_api_prepare_by_cell_id(client):
    ondemand.set_fetch(FakePower())
    r = client.post("/v1/weather/prepare",
                    json={"location": {"cell_id": PERGAMINO_CELL}, "wait_s": 30})
    assert r.json()["job_status"] == "ready"


def test_api_get_unprepared_cell(client):
    r = client.get(f"/v1/weather/{PERGAMINO_CELL}")
    assert r.status_code == 200
    assert r.json()["job_status"] == "failed" and r.json()["reason"] == "not_prepared"
    assert r.json()["meta"]["snapshot_hash"] is None


@pytest.mark.parametrize("loc,code", [
    ({"latitude": 1.0}, "incomplete_point"),
    ({"latitude": 1.0, "longitude": 2.0, "cell_id": PERGAMINO_CELL}, "location_conflict"),
    ({"cell_id": "nope"}, "invalid_cell"),
])  # fmt: skip
def test_api_prepare_bad_location(client, loc, code):
    r = client.post("/v1/weather/prepare", json={"location": loc})
    assert r.status_code == 400 and r.json()["issues"][0]["code"] == code
    assert r.json()["snapshot_hash"] is None


def test_api_prepare_out_of_range_point_is_400(client):
    r = client.post("/v1/weather/prepare", json={"location": {"latitude": 95, "longitude": 0}})
    assert r.status_code == 400 and r.json()["status"] == "invalid_input"


def test_api_get_bad_cell_id_is_400(client):
    r = client.get("/v1/weather/cell_1_2")
    assert r.status_code == 400 and r.json()["issues"][0]["code"] == "invalid_cell"


def test_api_union_county_is_committed_offline(client, monkeypatch):
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    r = client.post("/v1/weather/prepare", json={"location": {"latitude": 34.98,
                                                              "longitude": -80.55}})  # fmt: skip
    body = r.json()
    assert body["source"] == "committed" and body["job_status"] == "ready"
    assert body["snapshot_hash"] == get_index().by_id("union").snapshot_hash


def test_weather_logs_carry_no_coordinates(client, caplog):
    ondemand.set_fetch(FakePower(error=PowerFetchError("HTTP 503 at lat -34 lon -60.625")))
    with caplog.at_level("DEBUG"):
        client.post("/v1/weather/prepare",
                    json={"location": {"latitude": PERGAMINO[0], "longitude": PERGAMINO[1]},
                          "wait_s": 10})  # fmt: skip
    text = caplog.text
    assert "-33.89" not in text and "-60.57" not in text and "-60.625" not in text


def test_capability_block_for_b1_starts_nothing(monkeypatch):
    fake = FakePower()
    ondemand.set_fetch(fake)
    cap = ondemand.capability(*PERGAMINO)
    assert cap["cell_id"] == PERGAMINO_CELL and cap["reason"] == "not_prepared"
    assert cap["origin"] == "nasa_modeled" and fake.calls == []
    union = ondemand.capability(34.98, -80.55)
    assert (union["status"], union["job_status"], union["source"]) == ("complete", "ready",
                                                                       "committed")  # fmt: skip


# --------------------------------------------------------------------------- review fixes (A1.md)


def test_real_client_logs_no_coordinates(caplog):
    """httpx logs request URLs at INFO; the POWER query string (coordinates) is stripped."""
    import logging

    import httpx

    from acre.weather.power_client import fetch_daily

    body = FIXTURE.read_bytes()
    transport = httpx.MockTransport(lambda r: httpx.Response(200, content=body))

    def real(lat, lon, start, end, **kw):
        return fetch_daily(lat, lon, start, end, client=httpx.Client(transport=transport),
                           retries=kw.get("retries", 1), sleep=lambda s: None)  # fmt: skip

    ondemand.set_fetch(real)
    with caplog.at_level(logging.DEBUG):
        logging.getLogger("httpx").setLevel(logging.DEBUG)
        st = ondemand.prepare(_cell(), wait_s=30)
    assert st.job_status == "ready"
    assert "HTTP Request" in caplog.text  # httpx did log the request ...
    assert "-60.625" not in caplog.text and "-34" not in caplog.text  # ... without the query


def test_pointer_replace_failure_leaves_no_temp_files(tmp_path, monkeypatch):
    ondemand.set_fetch(FakePower())
    real_replace = ondemand.os.replace

    def boom(src, dst):
        if str(dst).endswith("current.json"):
            raise OSError("rename failed")
        return real_replace(src, dst)

    monkeypatch.setattr(ondemand.os, "replace", boom)
    st = ondemand.prepare(_cell(), wait_s=30)
    assert st.reason == "cache_write_failed"
    assert _files(tmp_path / "cache" / "weather" / PERGAMINO_CELL) == []


def test_polling_after_a_failed_refresh_reports_the_failure():
    ondemand.set_fetch(FakePower())
    first = ondemand.prepare(_cell(), wait_s=30)
    ondemand.set_fetch(FakePower(error=PowerFetchError("HTTP 503")))
    refreshed = ondemand.prepare(_cell(), refresh=True, wait_s=30)
    assert refreshed.job_status == "failed" and refreshed.reason == "power_unreachable"
    polled = ondemand.current(_cell())
    assert polled.job_status == "failed" and polled.notes  # not a silent "ready"
    again = ondemand.prepare(_cell())  # a plain prepare still serves the stored snapshot
    assert again.job_status == "ready" and again.snapshot_hash == first.snapshot_hash


def test_signed_zero_cell_ids_are_one_cell():
    a = ondemand.Cell.parse("cell_-0.000_-0.000")
    b = ondemand.Cell.parse("cell_+0.000_+0.000")
    assert a == b and a.cell_id == "cell_+0.000_+0.000"
    assert _cell(0.1, 0.1).cell_id == "cell_+0.000_+0.000"
    assert _cell(-0.1, -0.1).cell_id == "cell_+0.000_+0.000"


def test_a_cell_stored_by_another_process_is_not_fetched_again():
    """A-m1: the fetch runs under a per-cell file lock and re-checks the cache first."""
    first = FakePower()
    ondemand.fetch_and_store(_cell(), first)  # "another process" stored it
    second = FakePower()
    ondemand.set_fetch(second)
    s = ondemand._run(_cell())
    assert second.calls == [] and s.snapshot_hash
    refreshed_seen = ondemand._run(_cell(), refresh=True, seen="someone-else's-hash")
    assert second.calls == [] and refreshed_seen.snapshot_hash == s.snapshot_hash
