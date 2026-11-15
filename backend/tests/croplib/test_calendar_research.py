"""Calendar research for a known crop, and autofill using the stored calendar. Mocked model and
pages; synthetic text only."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from acre.catalogs import regional, sage
from acre.croplib import calendar_research, library
from acre.croplib import research as crop_research
from acre.research import client, verify
from acre.simulate.autofill import _midpoint
from acre.weather import ondemand

ECON = Path(__file__).resolve().parents[1] / "fixtures" / "economics"
PERG = {"latitude": -33.89, "longitude": -60.57}
UNION = {"latitude": 34.98, "longitude": -80.55}
GOV = "https://www.magyp.gob.ar/maiz-calendario"
BLOG = "https://maize-fan-blog.com/calendar"
Q_MAIZE = "maize is planted from september 15 to november 30 and harvested from february 15 to may 15"
Q_RYE = "cereal rye is seeded from april 1 to may 31 and terminated from august 1 to september 15"
Q_SOY = "soybean is planted from november 1 to december 10 and harvested from april 1 to may 20"
PAGES = {GOV: f"<p>{Q_MAIZE}. {Q_RYE}. {Q_SOY}.</p>", BLOG: f"<p>{Q_MAIZE}</p>"}
CROPS = [{"role": "previous", "crop_id": "field_corn"}, {"role": "next", "crop_id": "soybean"}]
WITH_COVER = [CROPS[0], {"role": "cover", "crop_id": "cereal_rye"}, CROPS[1]]


def item(plant, harvest, quote, url=GOV):
    return {"plant": {"start": plant[0], "end": plant[1]},
            "harvest": {"start": harvest[0], "end": harvest[1]} if harvest else None,
            "source_title": "Maize calendar", "source_url": url, "source_locator": "table 2",
            "evidence_quote": quote}  # fmt: skip


MAIZE = item(("09-15", "11-30"), ("02-15", "05-15"), Q_MAIZE)


def answer(*cals):
    return {"calendars": list(cals), "gaps": []}


def fake_fetch(url):
    if url in PAGES:
        return verify.Page(True, text=verify.normalise(PAGES[url]))
    return verify.Page(False, reason="http_404")


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    monkeypatch.setenv("ACRE_ECONOMICS_DIR", str(ECON))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("ACRE_RESEARCH_DOMAINS", raising=False)
    monkeypatch.setattr(verify, "fetch_page", fake_fetch)
    library.reset()
    calendar_research.reset()
    crop_research.reset()
    regional.clear_cache()
    ondemand.reset_jobs()
    yield
    client.set_caller(None)
    client.set_transport(None)
    library.reset()
    calendar_research.reset()
    regional.clear_cache()
    ondemand.reset_jobs()


@pytest.fixture()
def api():
    from acre.api.app import create_app

    return TestClient(create_app())


def calls_to(ans):
    seen = []
    client.set_caller(lambda body: seen.append(body) or ans)
    return seen


def post(api, **over):
    body = {"crop_id": "field_corn", "region_key": "AR-B", "wait_s": 10, **over}
    return api.post("/v1/calendars/research", json=body)


def autofill(api, location=PERG, crops=CROPS):
    r = api.post("/v1/plans/autofill", json={"location": location, "crops": crops})
    assert r.status_code == 200, r.text
    out = r.json()
    return out, {d["field"]: d for d in out["dates"]}


@pytest.fixture()
def no_sage(monkeypatch):
    def absent(*_):
        raise sage.SageUnavailable("test fixture: no gridded calendar")

    monkeypatch.setattr(sage, "calendars_at", absent)


# --------------------------------------------------------------------------- the job


def test_job_happy_path_stores_a_calendar_for_the_crop_and_region(api):
    seen = calls_to(answer(MAIZE, item(("09-15", "11-30"), None, Q_MAIZE, url=BLOG),
                           item(("09-15", "11-30"), None, Q_MAIZE, url="https://x.example.edu/z")))
    r = post(api).json()
    assert r["job_status"] == "ready" and r["status"] == "partial", r
    assert r["crop_id"] == "maize" and r["region_key"] == "AR-B" and r["reason"] is None
    assert r["found"] == {"calendars": 1}  # one calendar per region: the best supported is kept
    assert len(seen) == 1
    crop = api.get("/v1/crops/maize", params={"region_key": "AR-B"}).json()
    cal = crop["calendars"][0]
    assert cal["region_key"] == "AR-B" and cal["origin"] == "source_checked"
    assert cal["plant"] == {"start": "09-15", "end": "11-30"}
    assert cal["harvest"] == {"start": "02-15", "end": "05-15"}
    assert cal["source"]["url"] == GOV and cal["source"]["evidence_quote"] == Q_MAIZE
    assert crop["researched"] is False  # a built-in crop stays built in
    got = api.get(f"/v1/calendars/research/{r['job_id']}").json()
    assert got["job_status"] == "ready" and got["found"] == {"calendars": 1}
    assert library.research_status("calendars", "maize", "AR-B")["status"] == "partial"


def test_off_allowlist_dead_and_dateless_items(api):
    calls_to(answer(item(("09-15", "11-30"), None, Q_MAIZE, url=BLOG)))
    r = post(api).json()
    assert r["found"] == {"calendars": 1} and r["check"]["kept"]["ai_suggested"] == 1
    assert library.get_crop("maize", "AR-B")["calendars"][0]["origin"] == "ai_suggested"
    calls_to(answer(item(("09-15", "11-30"), None, Q_MAIZE, url="https://gone.example.edu/x"),
                    item(("10-02", "11-30"), None, Q_MAIZE)))  # 10-02 is not in the quote
    r = post(api, refresh=True).json()
    assert r["found"] == {"calendars": 0} and r["status"] == "insufficient_data"
    assert r["reason"] == "nothing_found"
    reasons = [d["reason"] for d in r["check"]["guardrails"]["dropped"]]
    assert any("unreachable" in x for x in reasons) and any("planting dates" in x for x in reasons)
    # nothing new was found, so the earlier researched calendar is kept
    assert library.get_crop("maize", "AR-B")["calendars"][0]["origin"] == "ai_suggested"


def test_cache_hit_then_refresh(api):
    seen = calls_to(answer(MAIZE))
    first = post(api).json()
    again = post(api).json()
    assert again["reason"] == "cached" and again["job_status"] == "ready" and len(seen) == 1
    assert again["found"] == first["found"] and "check" not in again
    assert post(api, refresh=True).json()["reason"] is None and len(seen) == 2
    assert len(library.get_crop("maize", "AR-B")["calendars"]) == 1  # replaced, not piled up


def test_pending_then_ready(api):
    gate, entered = threading.Event(), threading.Event()

    def slow(body):
        entered.set()
        gate.wait(10)
        return answer(MAIZE)

    client.set_caller(slow)
    r = post(api, wait_s=0).json()
    assert r["job_status"] == "pending" and r["found"] is None
    assert entered.wait(10)
    gate.set()
    for _ in range(100):
        got = api.get(f"/v1/calendars/research/{r['job_id']}").json()
        if got["job_status"] != "pending":
            break
        threading.Event().wait(0.1)
    assert got["job_status"] == "ready" and got["found"] == {"calendars": 1}


def test_unknown_crop_is_400_and_no_key_fails_with_a_reason(api):
    seen = calls_to(answer(MAIZE))
    r = post(api, crop_id="teffy_grass")
    assert r.status_code == 400 and r.json()["issues"][0]["code"] == "unknown_crop"
    assert "/v1/crops/research" in r.json()["issues"][0]["message"] and seen == []
    client.set_caller(None)
    off = post(api).json()
    assert off["job_status"] == "failed" and off["reason"] == "research_not_configured"
    assert off["reason_text"] and api.get("/v1/calendars/research/kj_nope").status_code == 400


def test_the_location_only_selects_the_sage_cell_and_is_never_sent(api):
    seen = calls_to(answer(item(("03-01", "03-31"), ("07-01", "07-31"),
                                "maize is planted from march 1 to march 31 and harvested from "
                                "july 1 to july 31")))
    PAGES[GOV] += ("<p>maize is planted from march 1 to march 31 and harvested from july 1 to "
                   "july 31</p>")
    try:
        r = post(api, location=PERG).json()
    finally:
        PAGES[GOV] = f"<p>{Q_MAIZE}. {Q_RYE}. {Q_SOY}.</p>"
    cal = library.get_crop("maize", "AR-B")["calendars"][0]
    assert cal["review"] == "manual_check" and cal["sage_check"]["plant"] is False  # vs SAGE
    assert r["check"]["guardrails"]["flagged"]
    text = str(seen[0])
    assert "-33.89" not in text and "-60.57" not in text and "latitude" not in text
    user = seen[0]["messages"][1]["content"]
    import json

    assert set(json.loads(user.split("data:\n")[1])) == {"crop_name", "crop_id", "role",
                                                         "region_key", "country"}
    assert seen[0]["plugins"][0]["max_results"] == calendar_research.SEARCH_RESULTS


# --------------------------------------------------------------------------- autofill


def test_autofill_has_the_new_fields_and_marks_missing_calendars(api, no_sage):
    out, d = autofill(api, crops=WITH_COVER)
    assert out["research"] == {"available": False, "region_key": "AR-B"}
    rows = {r["role"]: r for r in out["calendar_research"]}
    assert [r["role"] for r in out["calendar_research"]] == ["previous", "cover", "next"]
    assert rows["previous"] == {"crop_id": "field_corn", "role": "previous", "researched_at": None,
                                "missing": True}  # fmt: skip
    assert rows["next"]["missing"] is True and rows["cover"]["missing"] is True
    assert d["prev_harvest"]["value"] is None


def test_nothing_is_missing_when_the_gridded_calendar_has_the_dates(api):
    out, _ = autofill(api)
    assert [r["missing"] for r in out["calendar_research"]] == [False, False]


def test_a_researched_calendar_fills_a_date_the_catalogs_and_sage_lack(api, no_sage):
    calls_to(answer(MAIZE))
    assert post(api).json()["job_status"] == "ready"
    out, d = autofill(api)
    h = d["prev_harvest"]
    assert h["value"] == _midpoint("02-15", "05-15") and h["status"] == "complete"
    assert h["origin"] == "source_checked"
    assert h["source"]["url"] == GOV and h["source"]["region_key"] == "AR-B"
    assert h["source"]["method"] == "window_midpoint" and h["source"]["researched"] is True
    assert h["source"]["evidence_quote"] == Q_MAIZE
    assert d["next_plant"]["value"] is None  # soybean was not researched
    rows = {r["role"]: r for r in out["calendar_research"]}
    assert rows["previous"]["missing"] is False and rows["previous"]["researched_at"].endswith("Z")
    assert rows["next"]["missing"] is True and rows["next"]["researched_at"] is None
    assert not any(g["field"] == "prev_harvest" for g in out["gaps"])


def test_an_ai_suggested_calendar_is_labelled_and_flagged_as_a_gap(api, no_sage):
    calls_to(answer(item(("09-15", "11-30"), ("02-15", "05-15"), Q_MAIZE, url=BLOG)))
    post(api)
    out, d = autofill(api)
    assert d["prev_harvest"]["origin"] == "ai_suggested" and d["prev_harvest"]["value"]
    g = next(g for g in out["gaps"] if g["field"] == "prev_harvest")
    assert g["reason"] == "unverified_calendar" and "not verified" in g["text"]


def test_sage_and_the_verified_catalog_still_win(api):
    calls_to(answer(MAIZE))
    post(api)  # a researched calendar exists for AR-B, but SAGE has maize here
    out, d = autofill(api)
    assert d["prev_harvest"]["origin"] == "dataset_estimate"
    assert d["prev_harvest"]["source"].get("researched") is None
    assert d["next_plant"]["origin"] == "dataset_estimate"
    # NC: the verified rule date wins over a researched calendar for the same crop and region
    calls_to(answer(item(("06-01", "06-30"), ("10-01", "10-31"),
                         "soybean is planted june 1 to june 30 and harvested october 1 to october 31",
                         url="https://extension.example.edu/soy")))
    PAGES["https://extension.example.edu/soy"] = (
        "<p>soybean is planted june 1 to june 30 and harvested october 1 to october 31</p>")
    try:
        assert post(api, crop_id="soybean", region_key="US-NC").json()["job_status"] == "ready"
    finally:
        del PAGES["https://extension.example.edu/soy"]
    out, d = autofill(api, UNION)
    assert d["next_plant"]["origin"] == "verified_source" and d["next_plant"]["value"] == "05-05"
    assert d["prev_harvest"]["origin"] == "dataset_estimate"
    assert out["research"]["region_key"] == "US-NC"


def test_a_researched_cover_crop_window_replaces_the_assumed_dates(api, no_sage):
    calls_to(answer(MAIZE))
    post(api)
    calls_to(answer(item(("04-01", "05-31"), ("08-01", "09-15"), Q_RYE)))
    assert post(api, crop_id="cereal_rye").json()["job_status"] == "ready"
    calls_to(answer(item(("11-01", "12-10"), ("04-01", "05-20"), Q_SOY)))
    assert post(api, crop_id="soybean").json()["job_status"] == "ready"
    out, d = autofill(api, crops=WITH_COVER)
    assert d["next_plant"]["value"] == _midpoint("11-01", "12-10")
    seed, term = d["winter.seed"], d["winter.terminate"]
    assert seed["origin"] == "source_checked" and seed["source"]["researched"] is True
    assert term["origin"] == "source_checked" and term["value"] == _midpoint("08-01", "09-15")
    rows = {r["role"]: r for r in out["calendar_research"]}
    assert rows["cover"]["missing"] is False and rows["cover"]["researched_at"]


def test_autofill_reports_the_key_when_one_is_configured(api, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    out, _ = autofill(api, UNION)
    assert out["research"] == {"available": True, "region_key": "US-NC"}
    assert all(r["researched_at"] is None for r in out["calendar_research"])
