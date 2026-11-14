"""Rate limits, request hardening, security headers and production toggles (offline)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from fieldshift.api import security
from fieldshift.api.security import (
    ANALYSIS,
    CHEAP,
    GEO,
    RESEARCH,
    WEATHER,
    Buckets,
    DailyBudget,
    HeadersMiddleware,
    LimitsMiddleware,
    Settings,
    route_class,
)

STATUS = {"complete", "partial", "unavailable", "unknown", "inapplicable", "unsupported",
          "invalid_input", "manual_check", "insufficient_data"}  # fmt: skip


def _settings(**kw) -> Settings:
    limits = {CHEAP: (100, 60.0), ANALYSIS: (3, 60.0), GEO: (2, 60.0), WEATHER: (2, 60.0),
              RESEARCH: (100, 3600.0)}  # fmt: skip
    limits.update(kw.pop("limits", {}))
    return Settings(limits=limits, **kw)


def _fake_app(research_reply=None) -> Starlette:
    """A stand-in API: echoes the body; the research route answers ``research_reply``."""
    counter = {"n": 0}

    async def echo(request: Request) -> JSONResponse:
        body = await request.body()
        return JSONResponse({"status": "complete", "len": len(body)})

    async def research(request: Request) -> JSONResponse:
        await request.body()
        counter["n"] += 1
        reply = research_reply(counter["n"]) if research_reply else {"job_id": None}
        return JSONResponse(reply)

    app = Starlette(routes=[
        Route("/v1/plans/compare", echo, methods=["POST"]),
        Route("/v1/weather/prepare", echo, methods=["POST"]),
        Route("/v1/geo/search", echo),
        Route("/v1/crops", echo),
        Route("/v1/regions/research", research, methods=["POST"]),
    ])  # fmt: skip
    return app


def _client(settings: Settings, **kw) -> TestClient:
    return TestClient(LimitsMiddleware(_fake_app(**kw), settings))


def _assert_envelope(r, http: int, status: str, code: str) -> None:
    assert r.status_code == http
    doc = r.json()
    assert doc["status"] == status and doc["status"] in STATUS
    assert doc["issues"][0] == {**doc["issues"][0], "field": "request", "code": code}
    assert doc["reason_text"] and doc["request_id"] and "catalog_version" in doc


# ---- route classes ----------------------------------------------------------------------------

@pytest.mark.parametrize(("method", "path", "cls"), [
    ("GET", "/health", CHEAP), ("GET", "/v1/years", CHEAP), ("POST", "/v1/years", CHEAP),
    ("GET", "/v1/crops", CHEAP), ("GET", "/v1/regions/AR-B/profile", CHEAP),
    ("GET", "/v1/weather/cell_-34.000_-60.625", CHEAP),
    ("POST", "/v1/plans/compare", ANALYSIS), ("POST", "/v1/farms/analyze", ANALYSIS),
    ("POST", "/v1/plans/recommend", ANALYSIS), ("GET", "/v1/soil", ANALYSIS),
    ("GET", "/v1/live", ANALYSIS), ("GET", "/v1/seasons/2020/replay", ANALYSIS),
    ("GET", "/v1/plans/p1/note", ANALYSIS), ("POST", "/v1/fertilizer/calc", ANALYSIS),
    ("GET", "/v1/geo/search", GEO), ("GET", "/v1/geo/reverse", GEO),
    ("POST", "/v1/weather/prepare", WEATHER), ("POST", "/v1/regions/research", RESEARCH),
    ("GET", "/v1/regions/research/rj_1", CHEAP), ("OPTIONS", "/v1/plans/compare", None),
])  # fmt: skip
def test_route_classes(method, path, cls):
    assert route_class(method, path) == cls


# ---- rate limits ------------------------------------------------------------------------------

def test_429_after_n_requests_with_retry_after():
    c = _client(_settings())
    for _ in range(3):
        assert c.post("/v1/plans/compare", json={}).status_code == 200
    r = c.post("/v1/plans/compare", json={})
    _assert_envelope(r, 429, "unavailable", "rate_limited")
    assert int(r.headers["Retry-After"]) >= 1
    # other classes have their own buckets
    assert c.get("/v1/crops").status_code == 200


def test_geo_and_weather_prepare_have_tight_limits():
    c = _client(_settings())
    assert [c.get("/v1/geo/search?q=x").status_code for _ in range(3)] == [200, 200, 429]
    assert [c.post("/v1/weather/prepare", json={}).status_code for _ in range(3)] == [200, 200, 429]


def test_bucket_refills_over_time():
    now = [0.0]
    b = Buckets({ANALYSIS: (2, 60.0)}, 100, clock=lambda: now[0])
    assert b.take("c", ANALYSIS) == 0 and b.take("c", ANALYSIS) == 0
    assert b.take("c", ANALYSIS) == pytest.approx(30.0)
    now[0] = 30.0
    assert b.take("c", ANALYSIS) == 0


def test_different_clients_get_separate_buckets():
    c = _client(_settings(trust_proxy=True))
    for _ in range(3):
        c.post("/v1/plans/compare", json={}, headers={"X-Forwarded-For": "203.0.113.1"})
    a = c.post("/v1/plans/compare", json={}, headers={"X-Forwarded-For": "203.0.113.1"})
    b = c.post("/v1/plans/compare", json={}, headers={"X-Forwarded-For": "203.0.113.2"})
    assert (a.status_code, b.status_code) == (429, 200)


def test_x_forwarded_for_is_ignored_unless_trusted():
    c = _client(_settings(trust_proxy=False))
    codes = [c.post("/v1/plans/compare", json={},
                    headers={"X-Forwarded-For": f"203.0.113.{i}"}).status_code for i in range(4)]  # fmt: skip
    assert codes == [200, 200, 200, 429]  # one socket peer, one bucket


def test_client_key_hop_choice_and_hashing():
    scope = {"client": ("10.0.0.9", 1), "headers": [(b"x-forwarded-for", b"1.1.1.1, 2.2.2.2")]}
    first = security.client_key(scope, Settings(trust_proxy=True))
    right = security.client_key(scope, Settings(trust_proxy=True, proxy_hops=1))
    peer = security.client_key(scope, Settings())
    assert first == security.hash_client("1.1.1.1")
    assert right == security.hash_client("2.2.2.2")
    assert peer == security.hash_client("10.0.0.9")
    assert "1.1.1.1" not in first and len(first) == 16


def test_bucket_memory_is_bounded_and_swept():
    now = [0.0]
    b = Buckets({CHEAP: (5, 60.0)}, 100, clock=lambda: now[0])
    for i in range(500):
        b.take(f"c{i}", CHEAP)
    assert len(b) == 100
    now[0] = 1000.0  # everyone refilled
    b.take("new", CHEAP)
    assert len(b) == 1


# ---- research budget --------------------------------------------------------------------------

def _new_job(n):
    return {"job_id": f"rj_{n}", "job_status": "pending", "status": "unknown", "check": None}


def test_research_daily_cap_is_global_across_clients():
    c = _client(_settings(trust_proxy=True, research_daily=2), research_reply=_new_job)
    codes = [c.post("/v1/regions/research", json={"region_key": "AR-B"},
                    headers={"X-Forwarded-For": f"198.51.100.{i}"}).status_code for i in range(3)]  # fmt: skip
    assert codes == [200, 200, 429]
    r = c.post("/v1/regions/research", json={"region_key": "AR-B"},
               headers={"X-Forwarded-For": "198.51.100.77"})  # fmt: skip
    _assert_envelope(r, 429, "unavailable", "rate_limited")
    assert int(r.headers["Retry-After"]) <= 86_400


def test_research_cache_hits_do_not_use_the_budget():
    def cached(n):
        return {"job_id": f"rj_{n}", "job_status": "ready", "status": "partial", "check": None}

    c = _client(_settings(research_daily=1), research_reply=cached)
    assert all(c.post("/v1/regions/research", json={}).status_code == 200 for _ in range(5))


def test_research_per_client_limit():
    c = _client(_settings(limits={RESEARCH: (3, 3600.0)}), research_reply=_new_job)
    codes = [c.post("/v1/regions/research", json={}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_daily_budget_rolls_over_and_dedupes_jobs():
    day = ["2026-11-14"]
    b = DailyBudget(2, today=lambda: day[0])
    assert b.reserve()
    b.settle("rj_1", True)
    assert b.reserve()
    b.settle("rj_1", True)  # the same running job returned again: not a second job
    assert b.used == 1
    assert security.is_new_research_job({"job_id": "x", "job_status": "failed",
                                         "reason": "research_failed", "check": None})  # fmt: skip
    assert not security.is_new_research_job({"job_id": "x", "job_status": "failed",
                                             "reason": "research_not_configured"})  # fmt: skip
    assert b.reserve() and not b.reserve()
    day[0] = "2026-11-15"
    assert b.reserve()


# ---- request hardening ------------------------------------------------------------------------

def test_413_for_a_large_body():
    c = _client(_settings(max_body=1000))
    r = c.post("/v1/plans/compare", content=b"x" * 2000)
    _assert_envelope(r, 413, "invalid_input", "body_too_large")
    assert c.post("/v1/plans/compare", content=b"x" * 900).json()["len"] == 900


def test_413_for_a_chunked_body_without_content_length():
    c = _client(_settings(max_body=1000))

    def chunks():
        for _ in range(5):
            yield b"y" * 400

    r = c.post("/v1/plans/compare", content=chunks())
    assert r.status_code == 413


def test_long_query_string_is_refused():
    c = _client(_settings(max_query=100))
    _assert_envelope(c.get("/v1/crops?x=" + "a" * 200), 400, "invalid_input", "query_too_long")


@pytest.mark.parametrize("path", ["/v1/weather/prepare", "/v1/regions/research"])
def test_refresh_needs_the_admin_token(path):
    c = _client(_settings(admin_token="s3cret", limits={WEATHER: (10, 60.0)}))
    body = {"refresh": True}
    _assert_envelope(c.post(path, json=body), 403, "invalid_input", "admin_token_required")
    assert c.post(path, json=body, headers={"X-Admin-Token": "wrong"}).status_code == 403
    assert c.post(path, json=body, headers={"X-Admin-Token": "s3cret"}).status_code == 200
    assert c.post(path, json={"refresh": False}).status_code == 200


def test_refresh_is_disabled_in_production_without_a_token():
    prod = _client(_settings(production=True))
    assert prod.post("/v1/weather/prepare", json={"refresh": True}).status_code == 403
    dev = _client(_settings(production=False))
    assert dev.post("/v1/weather/prepare", json={"refresh": True}).status_code == 200


# ---- the real app -----------------------------------------------------------------------------

@pytest.fixture
def make_app(monkeypatch):
    def build(**env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        from fieldshift.api.app import create_app

        return TestClient(create_app())

    return build


def test_security_headers_on_every_response(make_app):
    c = make_app()
    for r in (c.get("/health"), c.get("/v1/nope"), c.post("/v1/plans/compare", json={})):
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "no-referrer"
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
        assert "strict-transport-security" not in r.headers
        assert "server" not in r.headers
    assert c.post("/v1/plans/compare", json={}).headers["cache-control"] == "no-store"
    assert c.get("/health").headers.get("cache-control") != "no-store"


def test_production_hides_docs_and_adds_hsts(make_app):
    c = make_app(FIELDSHIFT_ENV="production", FIELDSHIFT_CORS_ORIGINS="https://acre-web.example")
    assert c.get("/docs").status_code == 404
    assert c.get("/redoc").status_code == 404
    assert c.get("/openapi.json").status_code == 200
    assert "max-age" in c.get("/health").headers["strict-transport-security"]
    dev = make_app(FIELDSHIFT_ENV="development")
    assert dev.get("/docs").status_code == 200


def test_production_errors_carry_no_traceback(make_app):
    c = make_app(FIELDSHIFT_ENV="production", FIELDSHIFT_CORS_ORIGINS="https://acre-web.example")

    @c.app.get("/__boom")
    def boom():
        raise RuntimeError("secret detail /Users/x/file.py")

    r = TestClient(c.app, raise_server_exceptions=False).get("/__boom")
    assert r.status_code == 500
    assert "secret" not in r.text and "Traceback" not in r.text
    assert r.json()["issues"][0]["code"] == "internal_error"


def test_cors_never_allows_a_wildcard_and_production_ignores_dev_defaults(make_app, monkeypatch):
    from fieldshift.api.app import cors_origins

    monkeypatch.setenv("FIELDSHIFT_CORS_ORIGINS", "*, https://a.example")
    assert cors_origins() == ["https://a.example"]
    monkeypatch.delenv("FIELDSHIFT_CORS_ORIGINS")
    monkeypatch.setenv("FIELDSHIFT_ENV", "production")
    assert cors_origins() == []
    c = make_app(FIELDSHIFT_CORS_ORIGINS="https://a.example")
    pre = c.options("/v1/plans/compare", headers={
        "Origin": "https://a.example", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "X-Admin-Token"})  # fmt: skip
    assert pre.status_code == 200
    assert "x-admin-token" in pre.headers["access-control-allow-headers"].lower()
    bad = c.options("/v1/plans/compare", headers={
        "Origin": "https://a.example", "Access-Control-Request-Method": "DELETE"})  # fmt: skip
    assert bad.status_code == 400


def test_real_app_429_is_readable_cross_origin(make_app):
    c = make_app(FIELDSHIFT_RATE_GEO_PER_MIN="1", FIELDSHIFT_CORS_ORIGINS="https://a.example")
    h = {"Origin": "https://a.example"}
    c.get("/v1/geo/search?q=-33.89,-60.57", headers=h)
    r = c.get("/v1/geo/search?q=-33.89,-60.57", headers=h)
    assert r.status_code == 429
    assert r.headers["access-control-allow-origin"] == "https://a.example"
    assert "retry-after" in r.headers["access-control-expose-headers"].lower()


def test_real_app_weather_refresh_needs_the_token(make_app):
    c = make_app(FIELDSHIFT_ADMIN_TOKEN="tok", FIELDSHIFT_OFFLINE="1")
    body = {"location": {"latitude": -33.89, "longitude": -60.57}, "refresh": True}
    r = c.post("/v1/weather/prepare", json=body)
    assert r.status_code == 403 and r.json()["issues"][0]["code"] == "admin_token_required"


def test_real_app_413(make_app):
    c = make_app(FIELDSHIFT_MAX_BODY_BYTES="2000")
    r = c.post("/v1/farms/analyze", content=json.dumps({"pad": "x" * 5000}),
               headers={"Content-Type": "application/json"})  # fmt: skip
    assert r.status_code == 413 and r.json()["issues"][0]["code"] == "body_too_large"


def test_geo_q_is_at_most_200_characters(make_app):
    r = make_app().get("/v1/geo/search?q=" + "a" * 201)
    assert r.status_code == 400 and r.json()["issues"][0]["code"] == "too_long"


def test_headers_middleware_replaces_cache_control_on_posts():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"cache-control", b"max-age=60"), (b"server", b"x")]})  # fmt: skip
        await send({"type": "http.response.body", "body": b"{}"})

    r = TestClient(HeadersMiddleware(app, production=False)).post("/x")
    assert r.headers["cache-control"] == "no-store" and "server" not in r.headers
