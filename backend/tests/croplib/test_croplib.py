"""S4: the crop library (SQLite) and AI crop research with a mocked OpenRouter. Synthetic only."""

from __future__ import annotations

import json
import re
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from acre.catalogs import crop_ids, regional
from acre.croplib import library, research
from acre.research import client, verify

EDU = "https://extension.example.edu/okra"
BLOG = "https://okra-fan-blog.com/okra"
Q_CROP = "okra (abelmoschus esculentus, malvaceae) is harvested about 60 days after planting"
Q_CAL = "plant okra from april 20 to june 15 and harvest from july 1 to october 15"
Q_PRICE = "okra sold for 1.85 dollars per pound at wholesale"
PAGES = {EDU: f"<p>{Q_CROP}. {Q_CAL}. {Q_PRICE}.</p>", BLOG: f"<p>{Q_CAL}</p>"}
UNION = {"latitude": 34.98, "longitude": -80.55}
ECON = Path(__file__).resolve().parents[1] / "fixtures" / "economics"


def ev(url=EDU, quote=Q_CAL):
    return {"source_title": "Okra guide", "source_url": url, "source_locator": "p1",
            "evidence_quote": quote}  # fmt: skip


def answer(**over):
    a = {"crop": {"name": "Okra", "scientific_name": "Abelmoschus esculentus",
                  "family": "Malvaceae", "role": "cash_crop", "season_length_days": 60,
                  **ev(quote=Q_CROP)},
         "calendars": [{"plant": {"start": "04-20", "end": "06-15"},
                        "harvest": {"start": "07-01", "end": "10-15"}, **ev()}],
         "economics_refs": [
             {"kind": "price", "value": 1.85, "unit": "USD/lb", "currency": "USD", "year": 2024,
              **ev(quote=Q_PRICE)},
             {"kind": "yield", "value": 9000, "unit": "lb/acre", "currency": None, "year": 2024,
              **ev(quote=Q_PRICE)}],  # 9000 is not in its quote: dropped
         "gaps": []}  # fmt: skip
    a.update(over)
    return a


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
    from acre.economics import data

    data.clear_cache()
    library.reset()
    research.reset()
    regional.clear_cache()
    yield
    client.set_caller(None)
    client.set_transport(None)
    library.reset()
    research.reset()
    regional.clear_cache()


@pytest.fixture()
def api():
    from acre.api.app import create_app

    return TestClient(create_app())


def calls_to(ans):
    seen = []
    client.set_caller(lambda body: seen.append(body) or ans)
    return seen


def test_the_library_is_a_seeded_sqlite_file(api):
    r = api.get("/v1/crops/search", params={"q": "soy", "region_key": "US-NC"}).json()
    soy = r["results"][0]
    assert soy["crop_id"] == "soybean" and soy["origin"] == "verified_source"
    assert soy["has_calendar"] is True and soy["has_economics"] is True  # fixture NC price
    assert (Path(library.db_path())).name == "croplib.sqlite" and library.db_path().exists()
    none = api.get("/v1/crops/search", params={"q": "okra"}).json()
    assert none["results"] == [] and none["can_research"] is True
    rec = api.get("/v1/crops/maize", params={"region_key": "US-NC"}).json()
    assert rec["family"] == "Poaceae" and "field_corn" in rec["aliases"]
    assert {e["region_key"] for e in rec["economics_refs"]} == {"US"}  # NC's own country only
    assert api.get("/v1/crops/maize", params={"region_key": "AR"}).json()["economics_refs"][0][
        "region_key"] == "AR"
    assert api.get("/v1/crops/maize", params={"region_key": "BR"}).json()["economics_refs"] == []
    assert api.get("/v1/crops/nope_crop").status_code == 400


def test_research_an_unknown_crop_and_cache_it_for_everyone(api):
    seen = calls_to(answer())
    r = api.post("/v1/crops/research", json={"name": "Okra", "region_key": "US-NC",
                                             "wait_s": 10}).json()  # fmt: skip
    assert r["job_status"] == "ready" and r["crop_id"] == "okra", r
    got = api.get(f"/v1/crops/research/{r['job_id']}").json()
    crop = got["crop"]
    assert crop["origin"] == "source_checked" and crop["family"] == "Malvaceae"
    assert crop["season_length_days"] == 60 and crop["researched"] is True
    cal = crop["calendars"][0]
    assert cal["region_key"] == "US-NC" and cal["origin"] == "source_checked"
    assert cal["plant"] == {"start": "04-20", "end": "06-15"}
    assert cal["sage_check"]["status"] == "inapplicable"
    refs = crop["economics_refs"]
    assert [(e["kind"], e["value"]) for e in refs] == [("price", 1.85)]  # the 9000 was dropped
    assert refs[0]["used_for_money"] is False  # AI refs are never money
    dropped = got["check"]["guardrails"]["dropped"] if "check" in got else []
    assert any("not in the quote" in d["reason"] for d in dropped)
    # cached centrally: a second request (any user) makes no call
    again = api.post("/v1/crops/research", json={"name": "okra", "region_key": "US-NC"}).json()
    assert again["job_status"] == "ready" and again["reason"] == "cached" and len(seen) == 1
    hits = api.get("/v1/crops/search", params={"q": "okr", "region_key": "US-NC"}).json()
    assert hits["results"][0]["crop_id"] == "okra" and hits["results"][0]["has_calendar"]


def test_a_known_crop_is_never_researched(api):
    seen = calls_to(answer())
    for name in ("Soybean", "corn", "Groundnut"):
        r = api.post("/v1/crops/research", json={"name": name, "region_key": "US-NC"}).json()
        assert r["reason"] == "known_crop" and r["job_status"] == "ready" and r["crop_id"]
    assert seen == []


def test_researched_crops_are_usable_by_plans_calendars_and_economics():
    calls_to(answer())
    job = research.start("Okra", "US-NC", wait_s=10)
    assert job.job_status == "ready"
    crop_ids.clear_extra()  # as on another worker: the library is read back on a miss
    assert crop_ids.is_known("okra") and crop_ids.info("okra").family == "Malvaceae"
    from acre.planner.goals import Goals

    Goals.model_validate({"constraints": {"must_include": ["okra"]}})  # plans accept the id
    cal = regional.regional_catalog(UNION["latitude"], UNION["longitude"]).calendar("okra")
    assert cal and cal["origin"] == "source_checked" and cal["library"] is True
    # outside NC the regional index the planner uses carries it too
    calls_to(answer())
    assert research.start("Okra", "AR-B", wait_s=10).job_status == "ready"
    idx_ar, _ = regional.catalog_for_location({"latitude": -33.89, "longitude": -60.57})
    assert idx_ar.calendar("okra")["region_key"] == "AR-B"
    assert idx_ar.crop("okra") is not None
    from acre.economics import estimate_economics

    out = estimate_economics(UNION, ["okra"])
    okra = out["crops"][0]
    assert okra["status"] == "unavailable" and okra["price"] is None  # null money unless sourced
    # another region does not borrow a researched calendar
    fr = regional.regional_catalog(-31.4, -64.2)  # AR-X (Córdoba): no okra research there
    assert fr.calendar("okra") is None


def test_a_calendar_outside_sage_is_manual_check_and_not_used():
    sage = {"okra": {"plant": {"start": "11-01", "end": "11-30"},
                     "harvest": {"start": "02-01", "end": "02-28"}}}  # fmt: skip
    crop, cals, refs, g = research.check(answer(), "Okra", "US-NC", sage, fake_fetch)
    assert cals[0]["review"] == "manual_check" and cals[0]["sage_check"]["plant"] is False
    assert g["flagged"][0]["reason"] == "disagrees with gridded crop calendar"


def test_an_off_allowlist_domain_is_ai_suggested_and_a_missing_url_drops():
    a = answer(calendars=[{"plant": {"start": "04-20", "end": "06-15"},
                           "harvest": {"start": "07-01", "end": "10-15"}, **ev(url=BLOG)},
                          {"plant": {"start": "04-20", "end": "06-15"}, "harvest": None,
                           **ev(url="")}])  # fmt: skip
    crop, cals, refs, g = research.check(a, "Okra", "US-NC", {}, fake_fetch)
    assert [c["origin"] for c in cals] == ["ai_suggested"]
    assert any(d["reason"] == "no source_url" for d in g["dropped"])
    assert any("allowlist" in d["reason"] for d in g["downgraded"])


def test_bad_family_and_season_are_dropped_not_guessed():
    a = answer()
    a["crop"] = {**a["crop"], "family": "Hibiscus family", "season_length_days": 999}
    crop, *_ = research.check(a, "Okra", "US-NC", {}, fake_fetch)
    assert crop["family"] is None and crop["season_length_days"] is None


def test_no_coordinates_in_the_request_body(api, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    sent = []

    def handler(request):
        sent.append(request.content.decode())
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": json.dumps(answer())}}]})

    client.set_transport(httpx.MockTransport(handler))
    r = api.post("/v1/crops/research", json={"name": "Okra", "region_key": "US-NC",
                                             "location": UNION, "wait_s": 10}).json()  # fmt: skip
    assert r["job_status"] == "ready", r
    body = sent[0]
    assert not re.search(r"-?\d{1,3}\.\d{2,}", body)
    for v in ("34.98", "80.55", "latitude", "longitude", "sage_"):
        assert v not in body
    user = json.loads(body)["messages"][1]["content"]
    assert set(json.loads(user.split("data:\n")[1])) == {"crop_name", "region_key", "country"}


def test_schema_retry_and_failures(api):
    replies = ["not json", answer()]
    client.set_caller(lambda body: replies.pop(0))
    job = research.start("Okra", "US-NC", wait_s=10)
    assert job.job_status == "ready"
    client.set_caller(lambda body: "still not json")
    bad = research.start("Roselle", "US-NC", wait_s=10)
    assert bad.job_status == "failed" and bad.reason == "research_bad_output"
    client.set_caller(None)
    off = api.post("/v1/crops/research", json={"name": "Moringa", "region_key": "US-NC"}).json()
    assert off["job_status"] == "failed" and off["reason"] == "research_not_configured"


@pytest.mark.parametrize("body, field", [
    ({"region_key": "US-NC"}, "name"),
    ({"name": "x", "region_key": "US-NC"}, "name"),
    ({"name": "okra; drop table", "region_key": "US-NC"}, "name"),
    ({"name": "okra"}, "region_key"),
    ({"name": "okra", "region_key": "not a key"}, "region_key"),
])  # fmt: skip
def test_bad_input_is_typed(api, body, field):
    r = api.post("/v1/crops/research", json=body)
    assert r.status_code == 400 and r.json()["issues"][0]["field"] == field
