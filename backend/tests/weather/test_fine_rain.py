"""Card 30: the 10 km rain record beside the 50 km one. POWER is always mocked; no network."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime

import pytest
from fastapi.testclient import TestClient

from acre.api.app import create_app
from acre.weather import fine_rain, ondemand
from acre.weather.power_client import OfflineError, PowerFetchError, RawFetch

LAST = fine_rain._last_full_year()


def _body(fine_per_day: float = 3.0, coarse_per_day: float = 4.0, first: int = 2001,
          hole_year: int | None = None) -> bytes:  # fmt: skip
    """A POWER answer with a constant rain rate; ``hole_year`` loses most of its IMERG days."""
    fine: dict[str, float] = {}
    coarse: dict[str, float] = {}
    d = date(first, 1, 1)
    while d.year <= LAST + 1 and d < date(LAST + 1, 3, 1):
        key = d.strftime("%Y%m%d")
        fine[key] = -999.0 if d.year == hole_year and d.month > 2 else fine_per_day
        coarse[key] = coarse_per_day
        d = date.fromordinal(d.toordinal() + 1)
    return json.dumps({"properties": {"parameter": {"IMERG_PRECTOT": fine,
                                                     "PRECTOTCORR": coarse}}}).encode()  # fmt: skip


class FakePower:
    def __init__(self, body: bytes | None = None, error: Exception | None = None) -> None:
        self.body, self.error, self.calls = body or _body(), error, []

    def __call__(self, lat, lon, start, end, **kwargs):
        self.calls.append((lat, lon, start, end, kwargs.get("parameters")))
        self.time_standard = kwargs.get("time_standard")
        if self.error is not None:
            raise self.error
        return RawFetch(body=self.body, url="https://power.larc.nasa.gov/mocked", params={},
                        status_code=200, elapsed_s=0.0,
                        retrieved_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"))  # fmt: skip


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv(ondemand.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.delenv("ACRE_OFFLINE", raising=False)
    ondemand.reset_jobs()
    yield
    fine_rain.set_fetch(None)
    ondemand.reset_jobs()


def test_the_square_is_a_tenth_of_a_degree_and_only_its_centre_is_asked_for():
    assert fine_rain.fine_square(1.02, 35.0) == ("fine_+1.05_+35.05", 1.05, 35.05)
    assert fine_rain.fine_square(-33.89, -60.57) == ("fine_-33.85_-60.55", -33.85, -60.55)
    assert fine_rain.fine_square(1.0999, 35.0999)[1:] == (1.05, 35.05)
    assert fine_rain.fine_square(90, 180)[1:] == (89.95, 179.95)
    with pytest.raises(ValueError):
        fine_rain.fine_square(91, 0)
    power = FakePower()
    fine_rain.set_fetch(power)
    fine_rain.compare(1.0234567, 35.0345678)
    lat, lon, start, _end, params = power.calls[0]
    assert (lat, lon) == (1.05, 35.05)  # the square's centre, never the field's point
    assert start == "1998-01-01" and params == ["IMERG_PRECTOT", "PRECTOTCORR"]
    assert power.time_standard == "UTC"  # POWER serves IMERG on UTC days only


def test_an_answer_with_no_fine_rain_is_not_kept():
    """Found live: asked on local solar time, POWER answered every IMERG day as missing, and that
    empty answer was cached."""
    empty = json.dumps({"properties": {"parameter": {"IMERG_PRECTOT": {"20240101": -999.0},
                                                      "PRECTOTCORR": {"20240101": 3.0}}}}).encode()  # fmt: skip
    fine_rain.set_fetch(FakePower(empty))
    assert fine_rain.compare(1.02, 35.0)["status"] == "insufficient_data"
    good = FakePower()
    fine_rain.set_fetch(good)
    assert fine_rain.compare(1.02, 35.0)["status"] == "complete" and len(good.calls) == 1


def test_yearly_totals_of_both_records_side_by_side_and_what_they_differ_by():
    fine_rain.set_fetch(FakePower(_body(3.0, 4.0)))
    out = fine_rain.compare(1.02, 35.0)
    assert out["status"] == "complete" and out["reason"] is None
    assert out["fine"]["about_km"] == 10 and out["fine"]["origin"] == "nasa_measured"
    assert out["coarse"]["about_km"] == 50 and out["coarse"]["origin"] == "nasa_modeled"
    first = out["years"][0]
    assert first == {"year": 2001, "fine_mm": 1095.0, "coarse_mm": 1460.0}
    assert out["years"][-1]["year"] == LAST  # the unfinished year is left out
    s = out["summary"]
    assert s["years"] == LAST - 2000 and s["first_year"] == 2001 and s["last_year"] == LAST
    assert s["difference_pct"] == -25 and s["years_fine_lower"] == s["years"]
    assert "does not change any result" in out["note"]


def test_a_year_with_too_few_days_is_left_out_not_filled_in():
    fine_rain.set_fetch(FakePower(_body(hole_year=2010)))
    years = [r["year"] for r in fine_rain.compare(1.02, 35.0)["years"]]
    assert 2010 not in years and 2009 in years and 2011 in years


def test_it_is_fetched_once_and_then_read_from_the_cache():
    power = FakePower()
    fine_rain.set_fetch(power)
    a = fine_rain.compare(1.02, 35.0)
    b = fine_rain.compare(1.04, 35.03)  # another point in the same square
    assert len(power.calls) == 1 and a["years"] == b["years"]
    fine_rain.compare(1.15, 35.0)  # the next square north
    assert len(power.calls) == 2


def test_the_50_km_column_is_blank_when_the_square_centre_is_in_another_cell():
    # 35.305 E is in the 50 km cell centred on 35.0; the centre of its 10 km square (35.35) is not.
    cell = ondemand.Cell.from_point(1.02, 35.305)
    assert ondemand.Cell.from_point(1.05, 35.35).cell_id != cell.cell_id
    fine_rain.set_fetch(FakePower())
    out = fine_rain.compare(1.02, 35.305)
    assert out["status"] == "partial" and out["reason"] == "no_coarse_record"
    assert all(r["coarse_mm"] is None for r in out["years"]) and out["years"]
    assert out["summary"]["coarse_mean_mm"] is None and out["summary"]["difference_pct"] is None
    assert out["summary"]["fine_mean_mm"] == pytest.approx(1096, abs=1)  # leap years add a day


def test_failures_are_said_plainly_and_nothing_is_cached(monkeypatch):
    fine_rain.set_fetch(FakePower(error=PowerFetchError("HTTP 503")))
    out = fine_rain.compare(1.02, 35.0)
    assert out["status"] == "unavailable" and out["reason"] == "power_unreachable"
    assert out["years"] == [] and out["summary"] is None
    fine_rain.set_fetch(FakePower(error=OfflineError("offline")))
    assert fine_rain.compare(1.02, 35.0)["reason"] == "offline"
    power = FakePower()
    fine_rain.set_fetch(power)
    assert fine_rain.compare(1.02, 35.0)["status"] == "complete" and len(power.calls) == 1


def test_too_short_a_record_is_insufficient_data():
    fine_rain.set_fetch(FakePower(_body(first=LAST - 2)))
    assert fine_rain.compare(1.02, 35.0)["status"] == "insufficient_data"


def test_the_route_takes_a_point_and_never_echoes_it():
    fine_rain.set_fetch(FakePower())
    c = TestClient(create_app())
    r = c.post("/v1/weather/fine-rain", json={"latitude": 1.0234567, "longitude": 35.0345678})
    assert r.status_code == 200
    doc = r.json()
    assert doc["status"] == "complete" and doc["fine"]["center"] == {"latitude": 1.05,
                                                                       "longitude": 35.05}  # fmt: skip
    assert "1.0234567" not in r.text and "35.0345678" not in r.text
    assert c.post("/v1/weather/fine-rain", json={"latitude": 100, "longitude": 0}).status_code in (400, 422)
    assert c.post("/v1/weather/fine-rain", json={"latitude": 1}).status_code in (400, 422)
