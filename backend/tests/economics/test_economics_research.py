"""Economics research (prices, yields, costs of a known crop in a region) with a mocked model and
mocked pages: no network, synthetic text only."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from acre.catalogs import regional
from acre.croplib import library
from acre.croplib import research as crop_research
from acre.economics import data, estimate_economics, research
from acre.research import client, verify

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "economics"
UNION = {"latitude": 34.98, "longitude": -80.55}
EDU = "https://extension.example.edu/sorghum-budget"
BLOG = "https://sorghum-fan-blog.com/prices"
DEAD = "https://extension.example.edu/missing"
P22 = "Sorghum price received 10.10 dollars per bushel in 2022"
P23 = "Sorghum price received 11.20 dollars per bushel in 2023"
P24 = "Sorghum price received 12.40 dollars per bushel in 2024"
Y24 = "Sorghum yield was 52 bushels per acre in 2024"
C24 = "Total cost 480 dollars per acre in 2024"
S24 = "Seed cost 70 dollars per acre in 2024"
PAGES = {EDU: f"<p>{P22}. {P23}. {P24}. {Y24}. {C24}. {S24}.</p>", BLOG: f"<p>{P24}.</p>"}


def ev(url=EDU, quote=P24):
    return {"source_title": "Sorghum guide", "source_url": url, "source_locator": "table 1",
            "evidence_quote": quote}  # fmt: skip


def price(value, quote, year, url=EDU, unit="USD/bu"):
    return {"value": value, "unit": unit, "currency": "USD", "year": year, **ev(url, quote)}


def answer(**over):
    a = {"prices": [price(10.1, P22, 2022), price(11.2, P23, 2023), price(12.4, P24, 2024),
                    price(12.4, P24, 2024, url=BLOG),  # off the allowlist: ai_suggested
                    price(12.4, P24, 2024, url=DEAD),  # dead page: dropped
                    price(13.9, P24, 2024)],  # 13.9 is not in its quote: dropped
         "yields": [{"value": 52, "unit": "bu/acre", "currency": None, "year": 2024, **ev(
             quote=Y24)}],
         "costs": [{"cost_type": "total", "item": None, "value": 480, "unit": "USD/acre",
                    "currency": "USD", "year": 2024, **ev(quote=C24)},
                   {"cost_type": "item", "item": "seed", "value": 70, "unit": "USD/acre",
                    "currency": "USD", "year": 2024, **ev(quote=S24)}],
         "gaps": ["no custom rates found"]}  # fmt: skip
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
    monkeypatch.setenv("ACRE_ECONOMICS_DIR", str(FIX))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("ACRE_RESEARCH_DOMAINS", raising=False)
    monkeypatch.setattr(verify, "fetch_page", fake_fetch)
    data.clear_cache()
    library.reset()
    research.reset()
    crop_research.reset()
    regional.clear_cache()
    yield
    client.set_caller(None)
    client.set_transport(None)
    library.reset()
    research.reset()
    crop_research.reset()
    data.clear_cache()


@pytest.fixture()
def api():
    from acre.api.app import create_app

    return TestClient(create_app())


def calls_to(ans):
    seen = []
    client.set_caller(lambda body: seen.append(body) or ans)
    return seen


def post(api, **over):
    body = {"crop_id": "sorghum", "region_key": "US-NC", "wait_s": 10, **over}
    return api.post("/v1/economics/research", json=body)


# --------------------------------------------------------------------------- the job


def test_research_job_happy_path_stores_checked_and_suggested_refs(api):
    seen = calls_to(answer())
    r = post(api).json()
    assert r["job_status"] == "ready" and r["status"] == "partial", r
    assert r["crop_id"] == "sorghum" and r["region_key"] == "US-NC" and r["reason"] is None
    assert r["found"] == {"price": 4, "yield": 1, "cost": 2}
    dropped = [d["reason"] for d in r["check"]["guardrails"]["dropped"]]
    assert any("not in the quote" in d for d in dropped)
    assert any("unreachable" in d for d in dropped)
    assert r["check"]["kept"] == {"source_checked": 6, "ai_suggested": 1}
    assert r["check"]["gaps"] == ["no custom rates found"]
    assert len(seen) == 1
    got = api.get(f"/v1/economics/research/{r['job_id']}").json()
    assert got["job_status"] == "ready" and got["found"] == r["found"]
    refs = api.get("/v1/crops/sorghum", params={"region_key": "US-NC"}).json()["economics_refs"]
    by = {(e["kind"], e["item"], e["year"], e["origin"]) for e in refs}
    assert ("price", None, "2024", "source_checked") in by
    assert ("price", None, "2024", "ai_suggested") in by  # the blog: reachable, off the allowlist
    assert ("cost", "total", "2024", "source_checked") in by
    assert ("cost", "seed", "2024", "source_checked") in by
    assert all(e["used_for_money"] == (e["origin"] == "source_checked") for e in refs)
    assert not any(e["value"] == 13.9 for e in refs)
    ok = next(e for e in refs if e["kind"] == "yield")
    assert ok["unit"] == "bu/acre" and ok["source"]["evidence_quote"] == Y24


def test_a_second_request_is_cached_and_refresh_asks_again(api):
    seen = calls_to(answer())
    first = post(api).json()
    again = post(api).json()
    assert again["job_status"] == "ready" and again["reason"] == "cached" and len(seen) == 1
    assert again["found"] == first["found"] and "check" not in again  # a cache hit: no new job
    fresh = post(api, refresh=True).json()
    assert fresh["reason"] is None and len(seen) == 2
    # a refresh replaces the earlier researched rows instead of piling up
    refs = library.get_crop("sorghum", "US-NC")["economics_refs"]
    assert len([e for e in refs if e["kind"] == "yield"]) == 1


def test_a_refresh_that_finds_nothing_keeps_the_earlier_refs(api):
    calls_to(answer())
    post(api)
    calls_to({"prices": [], "yields": [], "costs": [], "gaps": ["nothing"]})
    r = post(api, refresh=True).json()
    assert r["job_status"] == "ready" and r["status"] == "insufficient_data"
    assert r["reason"] == "nothing_found" and r["found"] == {"price": 0, "yield": 0, "cost": 0}
    assert len(library.get_crop("sorghum", "US-NC")["economics_refs"]) == 7


def test_pending_then_ready(api):
    gate, entered = threading.Event(), threading.Event()

    def slow(body):
        entered.set()
        gate.wait(10)
        return answer()

    client.set_caller(slow)
    r = post(api, wait_s=0).json()
    assert r["job_status"] == "pending" and r["found"] is None and r["finished_at"] is None
    assert entered.wait(10)
    same = post(api, wait_s=0).json()  # the running job is returned, not a second one
    assert same["job_id"] == r["job_id"]
    gate.set()
    for _ in range(100):
        got = api.get(f"/v1/economics/research/{r['job_id']}").json()
        if got["job_status"] != "pending":
            break
        threading.Event().wait(0.1)
    assert got["job_status"] == "ready" and got["found"]["price"] == 4


def test_an_unknown_crop_is_a_400_that_points_to_crop_research(api):
    seen = calls_to(answer())
    r = post(api, crop_id="teffy_grass")
    assert r.status_code == 400
    issue = r.json()["issues"][0]
    assert issue["field"] == "crop_id" and issue["code"] == "unknown_crop"
    assert "/v1/crops/research" in issue["message"] and seen == []


@pytest.mark.parametrize("body, field", [
    ({"crop_id": "sorghum"}, "region_key"),
    ({"crop_id": "sorghum", "region_key": "not a key"}, "region_key"),
    ({"crop_id": "sorghum", "region_key": "koppen:Cfa"}, "region_key"),
    ({"crop_id": "sorghum", "region_key": "US", "wait_s": 500}, "wait_s"),
    ({"region_key": "US"}, "crop_id"),
])  # fmt: skip
def test_bad_input_is_typed(api, body, field):
    r = api.post("/v1/economics/research", json=body)
    assert r.status_code == 400 and field in {i["field"] for i in r.json()["issues"]}
    assert api.get("/v1/economics/research/ej_nope").status_code == 400


def test_without_a_key_the_job_fails_with_a_reason(api):
    r = post(api).json()
    assert r["job_status"] == "failed" and r["status"] == "unavailable"
    assert r["reason"] == "research_not_configured" and "OPENROUTER_API_KEY" in r["reason_text"]
    assert r["found"] is None


def test_the_request_carries_only_crop_region_and_country(api, monkeypatch):
    import httpx

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": json.dumps(answer())}}]})

    client.set_transport(httpx.MockTransport(handler))
    r = post(api, location=UNION).json()  # a location is not even read
    assert r["job_status"] == "ready", r
    body = sent[0]
    user = body["messages"][1]["content"]
    assert set(json.loads(user.split("data:\n")[1])) == {"crop_name", "crop_id", "region_key",
                                                         "country"}
    assert "34.98" not in json.dumps(body) and "latitude" not in json.dumps(body)
    assert body["plugins"] == [{"id": "web", "max_results": research.SEARCH_RESULTS}]
    assert body["response_format"]["json_schema"]["schema"] == research.ECON_SCHEMA
    assert body["temperature"] == 0 and "seed" in body
    assert "ambrook" not in body["messages"][0]["content"]
    assert "Items from any other source are discarded" in body["messages"][0]["content"] or (
        "discarded by code" in body["messages"][0]["content"])


def test_schema_retry_then_bad_output(api):
    replies = ["not json", answer()]
    client.set_caller(lambda body: replies.pop(0))
    assert post(api).json()["job_status"] == "ready"
    client.set_caller(lambda body: "still not json")
    bad = post(api, crop_id="maize").json()
    assert bad["job_status"] == "failed" and bad["reason"] == "research_bad_output"


def test_check_rules_on_value_unit_year_and_origin():
    a = answer(prices=[
        price(0, "Sorghum price 0 dollars per bushel", 2024),  # a zero price
        price(11.2, P23, 2023, unit="USD per bushel"),  # unit does not parse
        price(11.2, P23, 1985),  # year out of range
        price(11.2, P23, None),  # no year
        {**price(11.2, P23, 2023), "currency": "EUR"},  # currency contradicts the unit
        price(11.2, P23, 2023, unit="usd/bushels"),  # fine after normalising: USD/bu
        price(11.2, P23, 2023, unit="USD/bu") | {"evidence_quote": ""},
    ], yields=[{"value": 52, "unit": "bu/barrel", "currency": None, "year": 2024, **ev(
        quote=Y24)}], costs=[{"cost_type": "item", "item": "", "value": 70, "unit": "USD/acre",
                              "currency": "USD", "year": 2024, **ev(quote=S24)},
                             {"cost_type": "item", "item": "free seed", "value": 0,
                              "unit": "USD/acre", "currency": "USD", "year": 2024,
                              **ev(quote="Seed cost 0 dollars per acre")}])
    pages = dict(PAGES)
    pages[EDU] += "<p>Seed cost 0 dollars per acre</p>"
    refs, found, g = research.check(a, lambda u: verify.Page(
        True, text=verify.normalise(pages[u])) if u in pages else verify.Page(False, reason="x"))
    assert [(r["kind"], r["unit"], r["origin"]) for r in refs] == [
        ("cost", "USD/acre", "source_checked"), ("price", "USD/bu", "source_checked")]
    assert refs[0]["item"] == "free seed" and refs[0]["value"] == 0.0  # a real zero stays zero
    assert found == {"price": 1, "yield": 0, "cost": 1}
    assert len(g["dropped"]) == 8


def test_unit_normalising():
    n = research.normalise_unit
    assert n("price", "USD/tonnes") == ("USD/t", "USD") and n("price", "ARS/t") == ("ARS/t", "ARS")
    assert n("yield", "tonnes/hectare") == ("t/ha", "") and n("yield", "bu/acres")[0] == "bu/acre"
    assert n("cost", "USD/ha") == ("USD/ha", "USD") and n("cost", "USD/bu") is None
    assert n("price", "USD/acre") is None and n("yield", "t/t") is None
    assert n("price", "$/bu") is None and n("price", "USD") is None


# --------------------------------------------------------------------------- shared budget


def test_the_research_budget_and_rate_limit_are_shared(monkeypatch):
    monkeypatch.setenv("ACRE_RESEARCH_DAILY_LIMIT", "2")
    from acre.api.app import create_app

    api = TestClient(create_app())
    calls_to(answer())
    assert post(api).status_code == 200  # a new job uses a slot
    assert post(api).json()["reason"] == "cached"  # a cache hit gives its slot back
    assert post(api, crop_id="maize").status_code == 200  # the second slot
    over = post(api, refresh=True)
    assert over.status_code == 429 and over.json()["issues"][0]["code"] == "rate_limited"
    # crop research draws on the same daily budget
    crop = api.post("/v1/crops/research", json={"name": "Okra", "region_key": "US-NC"})
    assert crop.status_code == 429
    cal = api.post("/v1/calendars/research", json={"crop_id": "maize", "region_key": "US-NC"})
    assert cal.status_code == 429


def test_the_new_paths_use_the_research_limit_class():
    from acre.api.security import CHEAP, RESEARCH, route_class

    for path in ("/v1/economics/research", "/v1/calendars/research"):
        assert route_class("POST", path) == RESEARCH
    assert route_class("GET", "/v1/economics/research/ej_1") == CHEAP


# --------------------------------------------------------------------------- the estimate


def put(refs, crop="sorghum", region="US-NC"):
    library.store_economics(crop_id=crop, region_key=region, refs=refs, status="partial",
                            found={}, cache_key="test")  # fmt: skip


def ref(kind, value, unit, year, origin="source_checked", item=None, url=EDU, region=None):
    return {"kind": kind, "item": item, "value": value, "unit": unit, "year": year,
            "currency": unit.split("/")[0] if kind in ("price", "cost") else None,
            "origin": origin, "region_key": region,
            "source": {"title": "T", "url": url, "locator": "tab 1", "year": year,
                       "evidence_quote": f"quote {value}"}}  # fmt: skip


def sorghum(out):
    return next(c for c in out["crops"] if c["crop_id"] == "sorghum")


def test_source_checked_prices_make_low_median_high_and_fill_the_crop():
    put([ref("price", 10.1, "USD/bu", 2022), ref("price", 12.4, "USD/bu", 2024),
         ref("price", 11.2, "USD/bu", 2023), ref("yield", 50, "bu/acre", 2023),
         ref("yield", 52, "bu/acre", 2024), ref("cost", 480, "USD/acre", 2024, item="total"),
         ref("cost", 70, "USD/acre", 2024, item="seed")])
    out = estimate_economics(UNION, ["sorghum"])
    c = sorghum(out)
    p = c["price"]
    assert (p["low"], p["typical"], p["high"]) == (10.1, 11.2, 12.4)
    assert p["origin"] == "source_checked" and p["unit"] == "USD/bu" and p["currency"] == "USD"
    assert p["source"]["url"] == EDU and p["source"]["years"] == "2022-2024"
    assert p["source"]["evidence_quote"] and len(p["sources"]) == 3
    assert c["yield"]["value"] == 52 and c["yield"]["origin"] == "source_checked"  # newest year
    assert c["costs"]["total_per_area"]["value"] == 480  # the total, not total + items
    assert c["costs"]["items"][0]["origin"] == "source_checked"
    assert c["status"] == "complete" and c["margin_per_area"]["typical"] == round(
        11.2 * 52 - 480, 2)  # fmt: skip
    assert c["suggestions"] == []
    assert c["economics_research"]["researched_at"] is not None


def test_costs_without_a_total_use_the_items_of_one_source_and_year():
    put([ref("cost", 70, "USD/acre", 2024, item="seed"),
         ref("cost", 90, "USD/acre", 2024, item="fertilizer"),
         ref("cost", 999, "USD/acre", 2023, item="seed"),
         ref("cost", 55, "USD/acre", 2024, item="seed", url="https://a.example.edu/other")])
    c = sorghum(estimate_economics(UNION, ["sorghum"]))
    assert c["costs"]["total_per_area"]["value"] == 160
    assert {i["item"] for i in c["costs"]["items"]} == {"seed", "fertilizer"}


def test_table_rows_win_over_researched_refs_and_overrides_win_over_both():
    put([ref("price", 99, "USD/bu", 2024), ref("yield", 99, "bu/acre", 2024)], crop="soybean")
    out = estimate_economics(UNION, ["soybean"])
    soy = out["crops"][0]
    assert soy["price"]["origin"] == "verified_source" and soy["price"]["typical"] == 11.2
    assert soy["yield"]["origin"] == "dataset_estimate" and soy["yield"]["value"] == 44
    ov = estimate_economics(UNION, ["soybean"], None, [], {"soybean": {
        "price": {"value": 12.0, "unit": "USD/bu"}, "yield": {"value": 50, "unit": "bu/acre"}}})
    assert ov["crops"][0]["price"]["origin"] == ov["crops"][0]["yield"]["origin"] == "grower"


def test_ai_suggested_refs_are_only_suggestions():
    put([ref("price", 12.4, "USD/bu", 2024, origin="ai_suggested", url=BLOG),
         ref("cost", 70, "USD/acre", 2024, origin="ai_suggested", item="seed", url=BLOG),
         ref("yield", 52, "bu/barrel", 2024)])  # source_checked, but the unit cannot be used
    c = sorghum(estimate_economics(UNION, ["sorghum"]))
    assert c["price"] is None and c["yield"] is None and c["costs"]["total_per_area"] is None
    assert c["status"] == "unavailable"
    s = {(x["field"], x.get("item")): x for x in c["suggestions"]}
    assert set(s) == {("price", None), ("costs", "seed"), ("yield", None)}
    p = s[("price", None)]
    assert p["origin"] == "ai_suggested" and p["value"] == 12.4 and p["unit"] == "USD/bu"
    assert p["source"] == {"title": "T", "url": BLOG, "locator": "tab 1",
                           "evidence_quote": "quote 12.4"}  # fmt: skip
    assert p["year"] == 2024 and "not confirmed" in p["note"]
    assert "could not be converted" in s[("yield", None)]["note"]
    assert [x["year"] for x in c["suggestions"]] == sorted((x["year"] for x in c["suggestions"]),
                                                           reverse=True)  # fmt: skip


def test_suggestions_are_capped_at_six_newest_first():
    put([ref("price", 10 + i, "USD/bu", 2015 + i, origin="ai_suggested", url=BLOG)
         for i in range(9)])  # fmt: skip
    s = sorghum(estimate_economics(UNION, ["sorghum"]))["suggestions"]
    assert len(s) == 6 and s[0]["year"] == 2023 and s[-1]["year"] == 2018


def test_units_and_currencies_are_never_mixed():
    put([ref("price", 12.0, "USD/bu", 2024), ref("price", 400.0, "USD/t", 2023),
         ref("price", 380.0, "EUR/t", 2022), ref("price", 11.0, "USD/bu", 2021, url=BLOG)])
    p = sorghum(estimate_economics(UNION, ["sorghum"]))["price"]
    # the group with the newest year is USD/bu from the .edu source; the blog's 2021 value is a
    # different source domain, the tonne prices a different unit
    assert (p["low"], p["typical"], p["high"], p["unit"]) == (12.0, 12.0, 12.0, "USD/bu")


def test_the_most_specific_region_with_references_is_used():
    put([ref("price", 20, "USD/bu", 2024)], region="US")
    put([ref("price", 12, "USD/bu", 2024)], region="US-NC")
    assert sorghum(estimate_economics(UNION, ["sorghum"]))["price"]["typical"] == 12
    put([ref("price", 12, "USD/bu", 2024)], region="US-VA")  # another state is never borrowed
    library.store_economics(crop_id="sorghum", region_key="US-NC",
                            refs=[ref("price", 15, "USD/bu", 2024)], status="partial",
                            found={}, cache_key="t")  # fmt: skip
    assert sorghum(estimate_economics(UNION, ["sorghum"]))["price"]["typical"] == 15
    only_va = estimate_economics({"region_key": "US-VA"}, ["sorghum"])
    assert sorghum(only_va)["price"]["typical"] == 12


def test_research_block_reflects_the_key_and_the_region(monkeypatch):
    out = estimate_economics(UNION, ["sorghum"])
    assert out["research"] == {"available": False, "region_key": "US-NC"}
    assert sorghum(out)["economics_research"] == {"researched_at": None, "status": None}
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    assert estimate_economics(UNION, ["sorghum"])["research"]["available"] is True
    assert estimate_economics(None, ["sorghum"])["research"] == {"available": True,
                                                                 "region_key": None}


def test_researched_at_is_set_after_a_job(api):
    calls_to(answer())
    assert post(api).json()["job_status"] == "ready"
    c = sorghum(estimate_economics(UNION, ["sorghum"]))
    assert c["economics_research"]["status"] == "partial"
    assert c["economics_research"]["researched_at"].endswith("Z")
    assert c["price"]["origin"] == "source_checked" and c["price"]["typical"] == 11.2
    # the estimate endpoint carries it too
    body = {"location": UNION, "crops": ["sorghum"]}
    out = api.post("/v1/economics/estimate", json=body).json()
    assert out["research"]["region_key"] == "US-NC"
    assert out["crops"][0]["economics_research"]["researched_at"] is not None
    assert any(x["origin"] == "ai_suggested" for x in out["crops"][0]["suggestions"])


def test_has_economics_counts_checked_refs():
    put([ref("price", 12, "USD/bu", 2024)])
    hits = library.search("sorghum", "US-NC")
    assert hits[0]["has_economics"] is True
    put([ref("price", 12, "USD/bu", 2024, origin="ai_suggested")], crop="sorghum", region="US-VA")
    assert library.search("sorghum", "US-VA")[0]["has_economics"] is False


# --------------------------------------------------------------------------- the simulator


def test_simulate_uses_a_crop_whose_money_is_only_source_checked(tmp_path, monkeypatch):
    from acre.simulate import seasons
    from acre.weather import ondemand
    from tests.simulate.test_simulate import NC_SCENARIOS

    empty = tmp_path / "econ"
    empty.mkdir()
    monkeypatch.setenv("ACRE_ECONOMICS_DIR", str(empty))
    data.clear_cache()
    ondemand.reset_jobs()
    seasons.clear_cache()
    for crop, p, y, c in (("maize", 4.5, 170, 700), ("soybean", 11.2, 48, 410)):
        put([ref("price", p, "USD/bu", 2024), ref("yield", y, "bu/acre", 2024),
             ref("cost", c, "USD/acre", 2024, item="total")], crop=crop)
    from acre.api.app import create_app

    body = {"location": UNION, "scenarios": NC_SCENARIOS, "years": 10, "runs": 50, "seed": 7,
            "start_season": "2027", "field": {"area_ha": 16.2},
            "economics": {"overrides": {"cereal_rye": {"costs": {"value": 45, "unit": "USD/acre"}},
                                        "crimson_clover": {"costs": {"value": 55,
                                                                     "unit": "USD/acre"}}}}}
    r = TestClient(create_app()).post("/v1/scenarios/simulate", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["method"]["money_source"] == "economics_library"
    assert out["crop_money"]["soybean"]["price"]["origin"] == "source_checked"
    assert out["crop_money"]["soybean"]["costs_per_area"]["origin"] == "source_checked"
    assert out["scenarios"][0]["money_status"] == "complete"
    acres = 16.2 / 0.40468564224
    y = out["scenarios"][0]["yearly"][0]["money"]["margin"]
    assert y["median"] == round(48 * 11.2 * acres - 410 * acres)  # 2027: corn -> soybean


# --------------------------------------------------------------------------- the old database


OLD_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE crops (
    crop_id TEXT PRIMARY KEY, name TEXT NOT NULL, scientific_name TEXT, family TEXT,
    roles TEXT NOT NULL, aliases TEXT NOT NULL, season_length_days INTEGER, origin TEXT NOT NULL,
    sources TEXT NOT NULL, researched INTEGER NOT NULL DEFAULT 0, in_sage INTEGER NOT NULL DEFAULT 0,
    in_catalog INTEGER NOT NULL DEFAULT 0, cached_at TEXT NOT NULL, notes TEXT);
CREATE TABLE calendars (
    crop_id TEXT NOT NULL, region_key TEXT NOT NULL, plant TEXT, harvest TEXT, origin TEXT NOT NULL,
    source TEXT, review TEXT, sage_check TEXT, cached_at TEXT NOT NULL,
    PRIMARY KEY (crop_id, region_key));
CREATE TABLE economics_refs (
    crop_id TEXT NOT NULL, region_key TEXT NOT NULL, kind TEXT NOT NULL, value REAL, unit TEXT,
    currency TEXT, year TEXT, origin TEXT NOT NULL, source TEXT, from_research INTEGER NOT NULL);
CREATE TABLE research (
    cache_key TEXT PRIMARY KEY, name TEXT NOT NULL, region_key TEXT NOT NULL, crop_id TEXT,
    raw TEXT, guardrails TEXT, created_at TEXT NOT NULL);
CREATE INDEX econ_crop ON economics_refs (crop_id, region_key);
"""


def test_a_database_file_with_the_old_schema_keeps_working():
    path = library.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript(OLD_SCHEMA)
    con.execute("INSERT INTO economics_refs VALUES ('sorghum','US-NC','price',9.9,'USD/bu','USD',"
                "'2020','ai_suggested','{}',1)")  # an old researched row
    con.commit()
    con.close()
    assert library.get_crop("sorghum", "US-NC") is not None  # opens, migrates, seeds
    with library.connect(seed=False) as c:
        cols = {r["name"] for r in c.execute("PRAGMA table_info(economics_refs)")}
        tables = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "item" in cols and {"economics_research", "calendar_research"} <= tables
    put([ref("price", 12, "USD/bu", 2024, item=None)])  # the new column and table are usable
    refs = library.get_crop("sorghum", "US-NC")["economics_refs"]
    assert {e["value"] for e in refs if e["kind"] == "price"} == {12.0}  # replaced on research
    assert library.research_status("economics", "sorghum", "US-NC")["status"] == "partial"
    library.reset()
    assert library.get_crop("sorghum", "US-NC") is not None  # a second open is fine too
    assert Path(path).exists()
