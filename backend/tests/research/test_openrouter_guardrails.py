"""OpenRouter client and deterministic guardrails, against a mocked OpenRouter (httpx.MockTransport).

Synthetic fixtures only; nothing reaches the network.
"""

from __future__ import annotations

import json
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from acre.catalogs import regional
from acre.research import client, guardrails, pipeline, prompt, verify
from acre.research.prompt import RegionQuery

REAL_SEND = httpx.Client.send  # captured before the conftest blocks it
OK_URL = "https://www.agricultura.gob.ar/guia"
BLOG_URL = "https://farm-tips-blog.com/maize"
QUOTE_MAIZE = "maize is sown from september 20 to october 31"
QUOTE_SOY = "soybean is sown from october 15 to december 15"
QUOTE_RYE = "end the rye at least 30 days before planting"
PAGES = {OK_URL: f"<p>{QUOTE_MAIZE}. {QUOTE_SOY}. {QUOTE_RYE}.</p>",
         BLOG_URL: f"<p>{QUOTE_MAIZE}.</p>"}  # fmt: skip
SAGE = {"maize": {"plant": {"start": "09-15", "end": "11-30"},
                  "harvest": {"start": "03-01", "end": "05-31"}},
        "soybean": {"plant": {"start": "10-20", "end": "12-31"},
                    "harvest": {"start": "03-15", "end": "05-31"}}}  # fmt: skip
Q = RegionQuery("AR-B", "AR", "AR-B", "Buenos Aires", "Argentina", "Cfa", ("maize", "soybean"),
                sage=SAGE)  # fmt: skip


def row(rule_id: str, **over):
    base = {"rule_id": rule_id, "crop_id": "maize", "rule_type": "planting_window",
            "growth_stage": None, "management_action": None, "production_system": None,
            "previous_crop_id": None, "next_crop_id": None, "window_start_mm_dd": "09-20",
            "window_end_mm_dd": "10-31", "condition_key": None, "operator": None,
            "value_min": None, "value_max": None, "unit": None, "suitability": "preferred",
            "applies_when": "main season", "guidance": "sow in this window", "limitations": None,
            "source_title": "Guia", "source_url": OK_URL, "source_locator": "table 1",
            "evidence_quote": QUOTE_MAIZE}  # fmt: skip
    return {**base, **over}


def answer(rows=None, crops=None):
    return {"rows": rows if rows is not None else [row("ar_b_t_001")],
            "crops": crops or [], "cover_crops": [], "rotations": [], "double_crops": [],
            "gaps": []}  # fmt: skip


def fake_fetch(url: str) -> verify.Page:
    if url in PAGES:
        return verify.Page(True, text=verify.normalise(PAGES[url]))
    return verify.Page(False, reason="http_404")


class Router:
    """A mocked OpenRouter: answers in order, records each request."""

    def __init__(self, *contents, status=200):
        self.contents = list(contents)
        self.requests: list[httpx.Request] = []
        self.status = status

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL(client.URL)
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"code": self.status}})
        c = self.contents.pop(0) if len(self.contents) > 1 else self.contents[0]
        text = c if isinstance(c, str) else json.dumps(c)
        return httpx.Response(200, json={"id": "gen-1", "model": "x", "choices": [
            {"finish_reason": "stop", "message": {"role": "assistant", "content": text}}]})

    def bodies(self):
        return [json.loads(r.content) for r in self.requests]


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(httpx.Client, "send", REAL_SEND)  # only MockTransport is ever used
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    monkeypatch.delenv("ACRE_RESEARCH_DOMAINS", raising=False)
    monkeypatch.delenv("ACRE_RESEARCH_MODEL", raising=False)
    monkeypatch.setattr(verify, "fetch_page", fake_fetch)
    pipeline.reset()
    regional.clear_cache()
    yield
    client.set_transport(None)
    client.set_caller(None)
    pipeline.reset()
    regional.clear_cache()


def mock(*contents, status=200) -> Router:
    r = Router(*contents, status=status)
    client.set_transport(httpx.MockTransport(r))
    return r


def rows_of(checked):
    return {r["rule_id"]: r for r in checked["rows"]}


# --------------------------------------------------------------------------- the client


def test_the_request_is_an_openrouter_chat_completion_with_generic_headers():
    router = mock(answer())
    pipeline.run(Q, fetch=fake_fetch)
    req = router.requests[0]
    assert req.headers["authorization"] == "Bearer test-key-not-real"
    assert req.headers["x-title"] == "A.C.R.E" and req.headers["http-referer"]
    body = router.bodies()[0]
    assert body["model"] == "anthropic/claude-sonnet-4.5"
    assert body["plugins"] == [{"id": "web", "max_results": 8}]
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["temperature"] == 0 and body["seed"] == prompt.SEED


def test_no_coordinates_in_the_request_body():
    router = mock(answer())
    api = TestClient(__import__("acre.api.app", fromlist=["create_app"]).create_app())
    r = api.post("/v1/regions/research", json={"location": {"latitude": -33.89,
                                                            "longitude": -60.57}, "wait_s": 30})  # fmt: skip
    assert r.status_code == 200 and r.json()["job_status"] == "ready", r.json()
    raw = router.requests[0].content.decode()
    assert not re.search(r"-?\d{1,3}\.\d{2,}", raw), re.findall(r"-?\d{1,3}\.\d{2,}", raw)
    for v in ("33.89", "60.57", "latitude", "longitude", "sage_", "09-15"):
        assert v not in raw  # no point, no cell label, no SAGE windows
    user = router.bodies()[0]["messages"][1]["content"]
    assert set(json.loads(user.split("data:\n")[1])) == {
        "region_key", "country", "country_name", "admin1", "admin1_name", "koppen", "crops"}


@pytest.mark.parametrize("status, code", [(429, "rate_limited"), (500, "provider_error"),
                                          (504, "research_timeout")])  # fmt: skip
def test_provider_errors_are_typed(status, code):
    mock(answer(), status=status)
    job = pipeline.start(Q, wait_s=10)
    assert job.job_status == "failed" and job.reason == code and job.status == "unavailable"


def test_a_timeout_is_research_timeout():
    def boom(request):
        raise httpx.ReadTimeout("slow", request=request)

    client.set_transport(httpx.MockTransport(boom))
    with pytest.raises(client.ResearchError) as e:
        client.call(prompt.request_params(Q))
    assert e.value.code == "research_timeout"


def test_without_a_key_research_is_not_configured(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY")
    router = mock(answer())
    job = pipeline.start(Q)
    assert job.reason == "research_not_configured" and router.requests == []


# --------------------------------------------------------------------------- guardrails


def test_a_disallowed_domain_is_downgraded_to_ai_suggested():
    mock(answer([row("ar_b_t_001"), row("ar_b_t_002", source_url=BLOG_URL)]))
    checked, log = pipeline.run(Q, fetch=fake_fetch)
    by = rows_of(checked)
    assert by["ar_b_t_001"]["origin"] == "source_checked"  # .gob.ar, quote on the page
    assert by["ar_b_t_002"]["origin"] == "ai_suggested"  # quote is on the page, domain is not ok
    down = log.guardrails["downgraded"]
    assert [d["item"] for d in down] == ["rows:ar_b_t_002"] and "allowlist" in down[0]["reason"]


def test_a_configured_domain_is_allowed(monkeypatch):
    monkeypatch.setenv("ACRE_RESEARCH_DOMAINS", "farm-tips-blog.com")
    assert guardrails.domain_allowed(BLOG_URL)
    for url in ("https://inta.gob.ar/x", "https://www.fao.org/x", "https://extension.umn.edu/x",
                "https://icar.org.in/x", "https://www.iari.res.in.ac.in/x",
                "https://agriculture.gouv.fr/x", "https://www.ars.usda.gov/x"):  # fmt: skip
        assert guardrails.domain_allowed(url), url
    assert not guardrails.domain_allowed("https://evil-gov.com/x")


def test_off_vocabulary_values_and_missing_urls_drop_the_row():
    rows = [row("ar_b_t_001"),
            row("ar_b_t_002", rule_type="termination_timing", condition_key="moon_phase",
                window_start_mm_dd=None, window_end_mm_dd=None),
            row("ar_b_t_003", crop_id="quinoa_x"),
            row("ar_b_t_004", source_url=""),
            row("ar_b_t_005", window_start_mm_dd="02-30")]  # fmt: skip
    guarded, log = guardrails.apply(answer(rows), SAGE)
    assert [r["rule_id"] for r in guarded["rows"]] == ["ar_b_t_001"]
    reasons = {d["item"]: d["reason"] for d in log.dropped}
    assert "condition_key 'moon_phase'" in reasons["rows:ar_b_t_002"]
    assert "quinoa_x" in reasons["rows:ar_b_t_003"]
    assert reasons["rows:ar_b_t_004"] == "no source_url"
    assert "02-30" in reasons["rows:ar_b_t_005"]


def test_numbers_outside_plausible_ranges_are_dropped():
    rows = [row("ar_b_t_001", rule_type="termination_timing", crop_id="cereal_rye",
                condition_key="days_between_termination_and_planting", operator="gte",
                value_min=30, unit="days", window_start_mm_dd=None, window_end_mm_dd=None,
                evidence_quote=QUOTE_RYE),
            row("ar_b_t_002", rule_type="termination_timing", crop_id="cereal_rye",
                condition_key="days_between_termination_and_planting", operator="gte",
                value_min=900, unit="days", window_start_mm_dd=None, window_end_mm_dd=None),
            row("ar_b_t_003", rule_type="weather_tolerance",
                condition_key="seed_zone_soil_temperature", operator="gte", value_min=300,
                unit="degF", window_start_mm_dd=None, window_end_mm_dd=None)]  # fmt: skip
    guarded, log = guardrails.apply(answer(rows), SAGE)
    assert [r["rule_id"] for r in guarded["rows"]] == ["ar_b_t_001"]
    assert all("plausible range" in d["reason"] for d in log.dropped)


def test_a_window_outside_sage_plus_30_days_is_manual_check():
    rows = [row("ar_b_t_001"),  # 09-20..10-31 inside SAGE 09-15..11-30
            row("ar_b_t_002", window_start_mm_dd="12-25", window_end_mm_dd="12-31",
                evidence_quote="sown from december 25 to december 31"),  # 25 days after SAGE
            row("ar_b_t_003", window_start_mm_dd="06-01", window_end_mm_dd="07-15")]  # far off
    crops = [{"crop_id": "soybean", "plant": {"start": "06-01", "end": "06-30"},
              "harvest": {"start": "03-20", "end": "05-15"}, "source_title": "Guia",
              "source_url": OK_URL, "source_locator": "t1",
              "evidence_quote": "soybean is sown from june 1 to june 30"}]  # fmt: skip
    mock(answer(rows, crops))
    checked, log = pipeline.run(Q, fetch=fake_fetch)
    by = rows_of(checked)
    assert "review" not in by["ar_b_t_001"] and by["ar_b_t_002"].get("review") is None
    assert by["ar_b_t_003"]["review"] == "manual_check"
    assert "disagrees with gridded crop calendar" in by["ar_b_t_003"]["limitations"]
    flagged = {f["item"] for f in log.guardrails["flagged"]}
    assert flagged == {"rows:ar_b_t_003", "crops:soybean"}
    prof = json.loads((pipeline.out_dir("AR-B") / "profile.json").read_text())
    assert prof["crops"] == [] and prof["flagged_crops"][0]["review"] == "manual_check"
    # the rule engine answers manual_check for the flagged row
    from acre.catalogs import crop_ids, v3

    parsed, _ = v3.parse_rules_text((pipeline.out_dir("AR-B") / "crop_rules.csv").read_text(),
                                    set(crop_ids.BY_ID))  # fmt: skip
    assert {r.rule_id: r.review for r in parsed}["ar_b_t_003"] == "manual_check"


def test_windows_across_new_year_are_compared_on_the_circle():
    assert guardrails.overlaps_sage({"start": "01-10", "end": "01-20"},
                                    {"start": "11-01", "end": "12-20"}) is True  # fmt: skip
    assert guardrails.overlaps_sage({"start": "03-01", "end": "03-10"},
                                    {"start": "11-01", "end": "01-15"}) is False  # fmt: skip
    assert guardrails.overlaps_sage({"start": "03-01", "end": "03-10"}, None) is None


def test_rows_are_sorted_deterministically_and_capped_at_60():
    rows = [row(f"ar_b_t_{i:03d}", source_url=f"{OK_URL}?p={99 - i:02d}") for i in range(70)]
    a, log_a = guardrails.apply(answer(rows), SAGE)
    b, _ = guardrails.apply(answer(list(reversed(rows))), SAGE)
    assert [r["rule_id"] for r in a["rows"]] == [r["rule_id"] for r in b["rows"]]
    assert len(a["rows"]) == 60 and sum("cap" in d["reason"] for d in log_a.dropped) == 10
    urls = [r["source_url"] for r in a["rows"]]
    assert urls == sorted(urls)


def test_more_than_half_dropped_marks_the_profile_partial_with_a_gap():
    rows = [row("ar_b_t_001"), *(row(f"ar_b_t_0{i}", crop_id="quinoa_x") for i in range(10, 13))]
    mock(answer(rows))
    pipeline.run(Q, fetch=fake_fetch)
    prof = json.loads((pipeline.out_dir("AR-B") / "profile.json").read_text())
    assert prof["status"] == "partial" and "AI output failed guardrails" in prof["gaps"]
    assert prof["research"]["guardrails"]["drift_stop"] is True
    g = json.loads((pipeline.out_dir("AR-B") / "guardrails.json").read_text())
    assert len(g["dropped"]) == 3 and g["items_in"] == 4


def test_half_or_fewer_dropped_is_not_a_drift_stop():
    mock(answer([row("ar_b_t_001"), row("ar_b_t_002", crop_id="quinoa_x")]))
    pipeline.run(Q, fetch=fake_fetch)
    prof = json.loads((pipeline.out_dir("AR-B") / "profile.json").read_text())
    assert "AI output failed guardrails" not in prof["gaps"]


# --------------------------------------------------------------------------- schema and cache


def test_invalid_json_is_retried_once_with_the_errors():
    router = mock("not json at all", answer())
    job = pipeline.start(Q, wait_s=10)
    assert job.job_status == "ready", job.reason
    first, second = router.bodies()
    assert len(second["messages"]) == len(first["messages"]) + 2
    assert second["messages"][-2] == {"role": "assistant", "content": "not json at all"}
    assert "did not validate" in second["messages"][-1]["content"]


def test_a_schema_violation_is_retried_and_a_second_failure_fails_the_job():
    bad = answer()
    bad["rows"][0]["rule_type"] = "made_up_type"  # enum violation
    router = mock(bad, bad)
    job = pipeline.start(Q, wait_s=10)
    assert job.job_status == "failed" and job.reason == "research_bad_output"
    assert len(router.requests) == 2 and "rule_type" in router.bodies()[1]["messages"][-1][
        "content"]  # fmt: skip


def test_a_cache_hit_makes_no_network_call_and_refresh_does():
    router = mock(answer())
    first = pipeline.start(Q, wait_s=10)
    assert first.job_status == "ready" and len(router.requests) == 1
    prof = json.loads((pipeline.out_dir("AR-B") / "profile.json").read_text())
    gen = prof["generation"]
    assert gen == {"model": "anthropic/claude-sonnet-4.5", "prompt_version": prompt.PROMPT_VERSION,
                   "cache_key": pipeline.cache_key(Q),
                   "guardrail_version": guardrails.GUARDRAIL_VERSION}  # fmt: skip
    raw = json.loads((pipeline.out_dir("AR-B") / "raw_response.json").read_text())
    assert raw[0]["id"] == "gen-1"  # the raw provider response is kept
    again = pipeline.start(Q, wait_s=10)
    assert again.job_status == "ready" and len(router.requests) == 1  # cache hit, no call
    pipeline.start(Q, refresh=True, wait_s=10)
    assert len(router.requests) == 2


def test_the_cache_key_changes_with_model_prompt_and_query(monkeypatch):
    k = pipeline.cache_key(Q)
    assert k == pipeline.cache_key(Q) and len(k) == 64
    monkeypatch.setenv("ACRE_RESEARCH_MODEL", "openai/gpt-5")
    assert pipeline.cache_key(Q) != k
    monkeypatch.delenv("ACRE_RESEARCH_MODEL")
    monkeypatch.setattr(prompt, "PROMPT_VERSION", "p-next")
    assert pipeline.cache_key(Q) != k
    monkeypatch.undo()
    other = RegionQuery("AR-B", "AR", "AR-B", "Buenos Aires", "Argentina", "Cfa", ("maize",))
    assert pipeline.cache_key(other) != pipeline.cache_key(Q)
    # SAGE windows are guardrail input, not part of the query or the key
    same = RegionQuery("AR-B", "AR", "AR-B", "Buenos Aires", "Argentina", "Cfa",
                       ("maize", "soybean"))  # fmt: skip
    assert pipeline.cache_key(same) == pipeline.cache_key(Q)


def test_ai_rows_never_print_unless_source_checked():
    from acre.contracts import Plan
    from acre.planner.checker import check_plan

    mock(answer([row("ar_b_t_001", crop_id="soybean", window_start_mm_dd="10-15",
                     window_end_mm_dd="12-15", evidence_quote=QUOTE_SOY),
                 row("ar_b_t_002", crop_id="soybean", window_start_mm_dd="10-15",
                     window_end_mm_dd="12-15", evidence_quote=QUOTE_SOY,
                     source_url=BLOG_URL.replace("maize", "soja"))]))  # fmt: skip
    PAGES[BLOG_URL.replace("maize", "soja")] = QUOTE_SOY
    try:
        pipeline.start(Q, wait_s=10)
        idx, _ = regional.catalog_for_location({"latitude": -33.89, "longitude": -60.57})
        plan = Plan(plan_id="t", previous_crop_id="maize", prev_harvest="04-15",
                    next_crop_id="soybean", next_plant="11-20")  # fmt: skip
        by = {c.rule_id: c for c in check_plan(plan, idx, year=2027).rules}
        assert by["ar_b_t_002"].origin == "ai_suggested" and not by["ar_b_t_002"].print
        assert by["ar_b_t_001"].origin == "source_checked"
        assert all(c.origin != "verified_source" for c in by.values())
    finally:
        PAGES.pop(BLOG_URL.replace("maize", "soja"))
