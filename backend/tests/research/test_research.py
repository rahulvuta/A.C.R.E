"""B3: AI regional research with a recorded (synthetic) model answer. Never calls a model or the web."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from acre.catalogs import regional
from acre.contracts import Plan
from acre.planner.checker import check_plan
from acre.research import client, pipeline, prompt, verify
from acre.research.prompt import RegionQuery

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "research"
ANSWER = json.loads((FIX / "ar_b_answer.json").read_text())
PAGES = json.loads((FIX / "pages.json").read_text())
PERGAMINO = {"latitude": -33.89, "longitude": -60.57}
Q = RegionQuery("AR-B", "AR", "AR-B", "Buenos Aires", "Argentina", "Cfa", ("soybean", "maize"))


def fake_fetch(url: str) -> verify.Page:
    if url in PAGES:
        return verify.Page(True, text=verify.normalise(PAGES[url]))
    return verify.Page(False, reason="http_404")


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    # the synthetic fixture cites .invalid hosts; allow them so quotes can be source_checked
    monkeypatch.setenv("ACRE_RESEARCH_DOMAINS",
                       "agency-a.invalid,uni-b.invalid,inst-c.invalid,gone.invalid")
    monkeypatch.setattr(verify, "fetch_page", fake_fetch)
    pipeline.reset()
    regional.clear_cache()
    yield
    client.set_caller(None)
    pipeline.reset()
    regional.clear_cache()


@pytest.fixture()
def api():
    from acre.api.app import create_app

    return TestClient(create_app())


def checked():
    return verify.check_answer(ANSWER, {"region_key": "AR-B", "country": "AR", "admin1": "AR-B",
                                        "koppen": "Cfa"}, fake_fetch)  # fmt: skip


def rows_by_id():
    out, _ = checked()
    return {r["rule_id"]: r for r in out["rows"]}


# --------------------------------------------------------------------------- the code check


def test_rows_parse_into_catalog_v3_and_quotes_decide_the_origin():
    from acre.catalogs import crop_ids, v3

    rows = rows_by_id()
    assert rows["ar_b_ai_001"]["origin"] == "source_checked"  # quote is on the page
    assert rows["ar_b_ai_002"]["origin"] == "ai_suggested"  # quote is not on the page
    csv_text = pipeline._csv(list(rows.values()))
    parsed, issues = v3.parse_rules_text(csv_text, set(crop_ids.BY_ID))
    assert {r.rule_id for r in parsed} == set(rows), [i.message for i in issues]
    assert all(r.region_key == "AR-B" and r.koppen == "Cfa" for r in parsed)


def test_a_number_not_in_its_quote_downgrades_the_row_to_manual_check():
    _, log = checked()
    r = rows_by_id()["ar_b_ai_003"]
    assert r["condition_key"] is None and r["suitability"] is None
    assert "value_min=21" in r["limitations"]
    assert {"rule_id": "ar_b_ai_003", "numbers_not_in_quote": ["value_min=21"]} in log.downgraded
    assert r["review"] == "manual_check"
    assert rows_by_id()["ar_b_ai_001"]["suitability"] == "preferred"  # dates are in its quote


def test_conflicting_rows_both_survive_naming_each_other():
    rows = rows_by_id()
    assert rows["ar_b_ai_004"]["conflicts_with"] == "ar_b_ai_005"
    assert rows["ar_b_ai_005"]["conflicts_with"] == "ar_b_ai_004"


def test_a_dead_url_drops_the_row_and_logs_it_and_unknown_crops_are_dropped():
    out, log = checked()
    assert "ar_b_ai_006" not in {r["rule_id"] for r in out["rows"]}
    assert {"item": "ar_b_ai_006", "reason": "source page http_404"} in log.dropped
    assert [c["crop_id"] for c in out["profile"]["crops"]] == ["soybean"]
    assert out["profile"]["gaps"] == ANSWER["gaps"]


def test_normalised_matching_ignores_case_spacing_entities_and_quotes():
    page = verify.normalise("<p>Sow  SOYBEAN&nbsp;between “October 15”</p>")
    assert verify.normalise('sow soybean between "october 15"') in page


@pytest.mark.parametrize("quote, row, missing", [
    ("leave at least 21 days", {"value_min": 21}, []),
    ("between 10,5 and 12 cm", {"value_min": 10.5, "value_max": 12}, []),
    ("leave three weeks", {"value_min": 21}, ["value_min=21"]),
    ("from 15 October", {"window_start_mm_dd": "10-15"}, []),
    ("in spring", {"window_start_mm_dd": "10-15"}, ["window_start_mm_dd=10-15"]),
])  # fmt: skip
def test_numbers_must_appear_in_the_quote(quote, row, missing):
    assert verify.unsupported_numbers({**row, "evidence_quote": quote}) == missing


# --------------------------------------------------------------------------- privacy


_COORD = re.compile(r"-?\d{1,3}\.\d{2,}")


def test_the_prompt_payload_contains_no_coordinates(api):
    seen: list[dict] = []
    client.set_caller(lambda params: seen.append(params) or ANSWER)
    r = api.post("/v1/regions/research", json={"location": PERGAMINO, "wait_s": 30})
    assert r.status_code == 200 and r.json()["job_status"] == "ready", r.json()
    blob = json.dumps(seen[0])
    assert not _COORD.search(blob.replace("2026", "")), _COORD.findall(blob)
    for v in ("-33.89", "-60.57", "-33.9", "-60.6", "latitude", "longitude", "lat", "lon"):
        assert f'"{v}"' not in blob and f" {v} " not in blob and v not in seen[0]["messages"][1][
            "content"].split("data:")[1]  # fmt: skip
    assert set(json.loads(seen[0]["messages"][1]["content"].split("data:\n")[1])) == {
        "region_key", "country", "country_name", "admin1", "admin1_name", "koppen", "crops"}


def test_region_query_has_no_coordinate_fields():
    assert not ({"latitude", "longitude", "lat", "lon", "point", "boundary"}
                & set(RegionQuery.__dataclass_fields__))  # fmt: skip


def test_request_uses_the_configured_model_and_web_tools(monkeypatch):
    p = prompt.request_params(Q)
    assert p["model"] == prompt.DEFAULT_MODEL == "anthropic/claude-sonnet-4.5"
    assert p["plugins"] == [{"id": "web", "max_results": 8}]
    rf = p["response_format"]
    assert rf["type"] == "json_schema" and rf["json_schema"]["strict"] is True
    assert rf["json_schema"]["schema"] is prompt.OUTPUT_SCHEMA
    assert p["temperature"] == 0 and isinstance(p["seed"], int) and p["max_tokens"] > 0
    monkeypatch.setenv("ACRE_RESEARCH_MODEL", "openai/gpt-5")
    assert prompt.request_params(Q)["model"] == "openai/gpt-5"


# --------------------------------------------------------------------------- jobs and catalog


def test_no_credentials_gives_unavailable_and_the_sage_profile_is_still_served(api):
    r = api.post("/v1/regions/research", json={"region_key": "AR-B"}).json()
    assert r["job_status"] == "failed" and r["status"] == "unavailable"
    assert r["reason"] == "research_not_configured" and r["reason_text"]
    p = api.get("/v1/regions/AR-B/profile", params={"lat": PERGAMINO["latitude"],
                                                    "lon": PERGAMINO["longitude"]}).json()  # fmt: skip
    assert p["status"] == "partial" and {c["crop_id"] for c in p["crops"]} >= {"soybean", "maize"}
    got = api.get(f"/v1/regions/research/{r['job_id']}").json()
    assert got["job_status"] == "failed"


def test_a_finished_job_is_cached_and_the_rule_engine_reads_ai_rows_with_origin(api):
    calls = []
    client.set_caller(lambda params: calls.append(1) or ANSWER)
    r = api.post("/v1/regions/research", json={"region_key": "AR-B", "wait_s": 30}).json()
    assert r["job_status"] == "ready" and r["profile_url"] == "/v1/regions/AR-B/profile"
    assert r["check"]["quotes_found"] >= 1 and r["check"]["dropped"]
    again = api.post("/v1/regions/research", json={"region_key": "AR-B", "wait_s": 30}).json()
    assert again["job_status"] == "ready" and calls == [1]  # cached per region key

    idx, state = regional.catalog_for_location(PERGAMINO)
    assert state["reason"] == "regional_profile" and state["origin"] == "ai_suggested"
    assert idx.calendar("soybean")["origin"] == "source_checked"  # profile wins over SAGE
    soy = Plan(plan_id="t", previous_crop_id="maize", prev_harvest="04-15",
               next_crop_id="soybean", next_plant="11-20")  # fmt: skip
    res = check_plan(soy, idx, year=2027)
    by = {c.rule_id: c for c in res.rules}
    assert by["ar_b_ai_001"].origin == "source_checked" and by["ar_b_ai_001"].status == "complete"
    assert all(c.origin in ("source_checked", "ai_suggested") for c in res.rules)
    # AI rows print only when source_checked (and otherwise worth printing)
    assert not any(c.print for c in res.rules if c.origin == "ai_suggested")

    prof = api.get("/v1/regions/AR-B/profile").json()
    assert prof["research"]["model"] == prompt.DEFAULT_MODEL and prof["disclaimer"]
    assert {x["origin"] for x in prof["rules"]} <= {"source_checked", "ai_suggested"}


def test_one_job_per_region_at_a_time():
    import threading

    gate = threading.Event()

    def slow(params):
        assert gate.wait(10)
        return ANSWER

    client.set_caller(slow)
    a = pipeline.start(Q)
    b = pipeline.start(Q)
    assert a.job_id == b.job_id and a.job_status == "pending"
    gate.set()
    for _ in range(100):
        if a.job_status != "pending":
            break
        threading.Event().wait(0.05)
    assert a.job_status == "ready"


def test_a_refused_or_broken_answer_fails_the_job_cleanly():
    def refuse(params):
        raise client.ResearchError("research_refused")

    client.set_caller(refuse)
    job = pipeline.start(Q, wait_s=10)
    assert job.job_status == "failed" and job.reason == "research_refused"
    with pytest.raises(client.ResearchError):
        client.parse_answer("not json")


def test_nc_is_never_researched_and_bad_input_is_typed(api):
    nc = api.post("/v1/regions/research", json={"region_key": "US-NC"}).json()
    assert nc["status"] == "complete" and nc["job_id"] is None
    for body, field in (({}, "region_key"), ({"region_key": "bad key"}, "region_key"),
                        ({"region_key": "AR-B", "crops": ["quinoa_x"]}, "crops"),
                        ({"location": {"latitude": 0, "longitude": -30}}, "location")):  # fmt: skip
        r = api.post("/v1/regions/research", json=body)
        assert r.status_code == 400 and r.json()["issues"][0]["field"] == field, body
    assert api.get("/v1/regions/research/nope").status_code == 400


# --------------------------------------------------------------------------- review fixes (B-m1.md)


def test_a_downgraded_row_is_evaluated_as_manual_check(api):
    client.set_caller(lambda params: ANSWER)
    pipeline.start(Q, wait_s=30)
    idx, _ = regional.catalog_for_location(PERGAMINO)
    soy = Plan(plan_id="t", previous_crop_id="soybean", prev_harvest="04-15",
               next_crop_id="soybean", next_plant="11-20")  # fmt: skip
    chk = check_plan(soy, idx, year=2027).rule("ar_b_ai_003")
    assert chk is not None and chk.status == "manual_check" and not chk.flagged


def test_profile_numbers_are_checked_against_their_quotes():
    out, log = checked()
    soy = next(c for c in out["profile"]["crops"] if c["crop_id"] == "soybean")
    assert soy["calendar"]["plant"] == {"start": "10-15", "end": "12-15"}  # in the quote
    assert soy["calendar"]["harvest"] is None  # 03-20..05-15 is not in its quote
    rye = out["profile"]["cover_crops"][0]
    assert rye["gap_days"] == 30 and rye["seed"] is None


@pytest.mark.parametrize("quote, row, missing", [
    ("sow from october 15", {"window_start_mm_dd": "10-01"}, ["window_start_mm_dd=10-01"]),
    ("keep above -2 degrees", {"value_min": 2}, ["value_min=2"]),
    ("keep above -2 degrees", {"value_min": -2}, []),
    ("about 1,000 seeds", {"value_min": 1000}, []),
])  # fmt: skip
def test_numbers_keep_their_sign_and_dates_their_whole_token(quote, row, missing):
    assert verify.unsupported_numbers({**row, "evidence_quote": quote}) == missing


def test_a_row_naming_an_unknown_neighbour_crop_is_dropped():
    bad = {**ANSWER["rows"][0], "rule_id": "ar_b_ai_099", "previous_crop_id": "quinoa_x"}
    out, log = verify.check_answer({"rows": [bad]}, {"region_key": "AR-B"}, fake_fetch)
    assert out["rows"] == [] and log.dropped[0]["reason"].startswith("unknown crop id")
