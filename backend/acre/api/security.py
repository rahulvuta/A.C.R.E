"""Rate limits, request hardening and security headers for the public deploy. Pure ASGI, no
dependencies, in memory (Render runs one instance; a restart forgets the counters).

* :class:`LimitsMiddleware` (inside CORS, so a 429 is readable by the browser):
  query string at most ``ACRE_MAX_QUERY_BYTES`` (400), body at most
  ``ACRE_MAX_BODY_BYTES`` (413, read no further than the limit), per-client token buckets
  by route class (429 with ``Retry-After``), ``refresh: true`` only with ``X-Admin-Token``
  (403), and a global daily budget of new AI research jobs.
* :class:`HeadersMiddleware` (outermost): security headers on every response, ``no-store`` on
  POST responses.

Clients are told apart by the socket peer, or by ``X-Forwarded-For`` when
``ACRE_TRUST_PROXY=1``. Addresses are hashed with a per-process salt as soon as they are
read and never logged.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

log = logging.getLogger("acre.security")
_SALT = secrets.token_bytes(16)

CHEAP, ANALYSIS, GEO, WEATHER, RESEARCH = "cheap", "analysis", "geo", "weather_prepare", "research"
RESEARCH_PATH = "/v1/regions/research"
RESEARCH_PATHS = frozenset({RESEARCH_PATH, "/v1/crops/research", "/v1/economics/research",
                            "/v1/calendars/research"})  # fmt: skip
REFRESH_PATHS = RESEARCH_PATHS | {"/v1/weather/prepare"}
# GETs that compute or call an outside service; every other GET is cheap.
_ANALYSIS_GET = re.compile(r"^/v1/(soil|live|locations/capabilities|seasons/[^/]+/replay"
                           r"|plans/[^/]+/note)$")  # fmt: skip
_CHEAP_POST = frozenset({"/v1/years"})


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        log.error("%s is not an integer; using %s", name, default)
        return default


def is_production() -> bool:
    return os.environ.get("ACRE_ENV", "").strip().lower() == "production"


@dataclass(frozen=True)
class Settings:
    # class -> (requests, per seconds)
    limits: dict[str, tuple[int, float]] = field(default_factory=dict)
    research_daily: int = 20
    max_body: int = 1_048_576
    max_query: int = 2048
    trust_proxy: bool = False
    proxy_hops: int = 0  # 0: first X-Forwarded-For hop; n: the n-th from the right
    admin_token: str = ""
    production: bool = False
    max_clients: int = 10_000

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            limits={
                CHEAP: (_env_int("ACRE_RATE_CHEAP_PER_MIN", 120), 60.0),
                ANALYSIS: (_env_int("ACRE_RATE_ANALYSIS_PER_MIN", 30), 60.0),
                GEO: (_env_int("ACRE_RATE_GEO_PER_MIN", 20), 60.0),
                WEATHER: (_env_int("ACRE_RATE_WEATHER_PER_MIN", 10), 60.0),
                RESEARCH: (_env_int("ACRE_RATE_RESEARCH_PER_HOUR", 3), 3600.0),
            },
            research_daily=_env_int("ACRE_RESEARCH_DAILY_LIMIT", 20),
            max_body=_env_int("ACRE_MAX_BODY_BYTES", 1_048_576),
            max_query=_env_int("ACRE_MAX_QUERY_BYTES", 2048),
            trust_proxy=os.environ.get("ACRE_TRUST_PROXY", "").strip() == "1",
            proxy_hops=max(0, _env_int("ACRE_PROXY_HOPS", 0)),
            admin_token=os.environ.get("ACRE_ADMIN_TOKEN", "").strip(),
            production=is_production(),
            max_clients=max(100, _env_int("ACRE_RATE_MAX_CLIENTS", 10_000)),
        )


def route_class(method: str, path: str) -> str | None:
    """The limit class of a request; ``None`` for CORS preflights (never limited)."""
    if method == "OPTIONS":
        return None
    if path in ("/v1/geo/search", "/v1/geo/reverse"):
        return GEO
    if method == "POST":
        if path == "/v1/weather/prepare":
            return WEATHER
        if path in RESEARCH_PATHS:
            return RESEARCH
        return CHEAP if path in _CHEAP_POST else ANALYSIS
    return ANALYSIS if _ANALYSIS_GET.match(path) else CHEAP


class Buckets:
    """Token buckets keyed by (client hash, class), in an LRU bounded at ``max_clients`` keys,
    with a sweep that drops buckets that have refilled completely (idle clients)."""

    def __init__(self, limits: dict[str, tuple[int, float]], max_keys: int,
                 clock: Callable[[], float] = time.monotonic) -> None:  # fmt: skip
        self.limits = limits
        self.max_keys = max_keys
        self.clock = clock
        self._b: OrderedDict[tuple[str, str], tuple[float, float]] = OrderedDict()
        self._lock = threading.Lock()
        self._swept = clock()

    def take(self, client: str, cls: str) -> float:
        """0.0 when allowed, else the seconds until a token is back."""
        cap, per = self.limits[cls]
        if cap <= 0:
            return per
        rate = cap / per
        now = self.clock()
        with self._lock:
            if now - self._swept > 60:
                self._sweep(now)
            key = (client, cls)
            tokens, last = self._b.pop(key, (float(cap), now))
            tokens = min(float(cap), tokens + (now - last) * rate)
            if tokens >= 1.0:
                self._b[key] = (tokens - 1.0, now)
                wait = 0.0
            else:
                self._b[key] = (tokens, now)
                wait = (1.0 - tokens) / rate
            while len(self._b) > self.max_keys:
                self._b.popitem(last=False)
            return wait

    def _sweep(self, now: float) -> None:
        self._swept = now
        for key, (tokens, last) in list(self._b.items()):
            cap, per = self.limits[key[1]]
            if tokens + (now - last) * cap / per >= cap:
                del self._b[key]

    def __len__(self) -> int:
        return len(self._b)


class DailyBudget:
    """New AI research jobs per UTC day, across all clients. A slot is reserved before the request
    runs and released when the answer shows no new AI call was made."""

    def __init__(self, limit: int, today: Callable[[], str] | None = None) -> None:
        self.limit = limit
        self.today = today or (lambda: datetime.now(UTC).strftime("%Y-%m-%d"))
        self._day = ""
        self._used = 0
        self._jobs: set[str] = set()
        self._lock = threading.Lock()

    def _roll(self) -> None:
        d = self.today()
        if d != self._day:
            self._day, self._used, self._jobs = d, 0, set()

    def reserve(self) -> bool:
        with self._lock:
            self._roll()
            if self._used >= self.limit:
                return False
            self._used += 1
            return True

    def settle(self, job_id: str | None, new_job: bool) -> None:
        with self._lock:
            self._roll()
            if new_job and job_id and job_id not in self._jobs:
                self._jobs.add(job_id)
                return
            self._used = max(0, self._used - 1)

    @property
    def used(self) -> int:
        with self._lock:
            self._roll()
            return self._used


def seconds_to_utc_midnight() -> int:
    now = datetime.now(UTC)
    return max(1, 86_400 - (now.hour * 3600 + now.minute * 60 + now.second))


def is_new_research_job(body: Any) -> bool:
    """A research answer that started an AI call: not NC (no job), not a cache hit (ready with no
    check log), not 'research is not configured'."""
    if not isinstance(body, dict) or not body.get("job_id"):
        return False
    if body.get("reason") == "research_not_configured":
        return False
    return not (body.get("job_status") == "ready" and body.get("check") is None)


def hash_client(addr: str) -> str:
    return hashlib.sha256(_SALT + addr.encode()).hexdigest()[:16]


def client_key(scope: Scope, settings: Settings) -> str:
    addr = ""
    if settings.trust_proxy:
        for name, value in scope.get("headers") or []:
            if name == b"x-forwarded-for":
                hops = [h.strip() for h in value.decode("latin-1").split(",") if h.strip()]
                if hops:
                    n = settings.proxy_hops
                    addr = hops[0] if n == 0 else hops[max(0, len(hops) - n)]
                break
    if not addr:
        peer = scope.get("client")
        addr = peer[0] if peer else "unknown"
    return hash_client(addr)


def _header(scope: Scope, name: bytes) -> str | None:
    for k, v in scope.get("headers") or []:
        if k == name:
            return v.decode("latin-1")
    return None


async def _send_json(send: Send, status: int, body: dict[str, Any],
                     headers: dict[str, str] | None = None) -> None:  # fmt: skip
    raw = json.dumps(body).encode()
    hs = [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())]
    hs += [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": hs})
    await send({"type": "http.response.body", "body": raw})


def envelope(status: str, code: str, message: str) -> dict[str, Any]:
    from acre.report.http import issue
    from acre.report.meta import response_meta

    return {"status": status, "issues": [issue("request", code, message)],
            "reason_text": message, **response_meta(weather=False)}  # fmt: skip


class _TooLarge(Exception):
    pass


class LimitsMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings | None = None) -> None:
        self.app = app
        self.settings = settings or Settings.from_env()
        self.buckets = Buckets(self.settings.limits, self.settings.max_clients)
        self.budget = DailyBudget(self.settings.research_daily)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        s = self.settings
        method, path = scope["method"], scope["path"]
        if len(scope.get("query_string") or b"") > s.max_query:
            await _send_json(send, 400, envelope(
                "invalid_input", "query_too_long",
                f"The query string is longer than {s.max_query} bytes."))  # fmt: skip
            return
        cls = route_class(method, path)
        if cls is not None:
            wait = self.buckets.take(client_key(scope, s), cls)
            if wait > 0:
                retry = max(1, math.ceil(wait))
                await _send_json(send, 429, envelope(
                    "unavailable", "rate_limited",
                    f"Too many requests; try again in {retry} seconds."),
                    {"Retry-After": str(retry)})  # fmt: skip
                return

        # The body, read no further than the limit, then replayed to the app.
        declared = _header(scope, b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > s.max_body:
            await self._too_large(send)
            return
        try:
            body = await self._read_body(receive) if method in ("POST", "PUT", "PATCH") else None
        except _TooLarge:
            await self._too_large(send)
            return

        if path in REFRESH_PATHS and method == "POST" and body:
            denied = self._refresh_denied(scope, body)
            if denied:
                await _send_json(send, 403, envelope("invalid_input", "admin_token_required",
                                                     denied))  # fmt: skip
                return

        inner_receive = receive
        if body is not None:
            sent = False

            async def inner_receive() -> Message:  # type: ignore[no-redef]
                nonlocal sent
                if not sent:
                    sent = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

        if cls == RESEARCH:
            await self._research(scope, inner_receive, send)
            return
        await self.app(scope, inner_receive, send)

    async def _too_large(self, send: Send) -> None:
        await _send_json(send, 413, envelope(
            "invalid_input", "body_too_large",
            f"The request body is larger than {self.settings.max_body} bytes."))  # fmt: skip

    async def _read_body(self, receive: Receive) -> bytes:
        chunks: list[bytes] = []
        size = 0
        while True:
            msg = await receive()
            if msg["type"] == "http.disconnect":
                break
            chunk = msg.get("body", b"")
            size += len(chunk)
            if size > self.settings.max_body:
                raise _TooLarge
            chunks.append(chunk)
            if not msg.get("more_body"):
                break
        return b"".join(chunks)

    def _refresh_denied(self, scope: Scope, body: bytes) -> str | None:
        try:
            doc = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return None  # the route reports the malformed body itself
        if not isinstance(doc, dict) or not doc.get("refresh"):
            return None
        token = self.settings.admin_token
        if not token:
            if self.settings.production:
                return "refresh is disabled on this server."
            return None  # development without a token: refresh stays open
        given = _header(scope, b"x-admin-token") or ""
        if not hmac.compare_digest(given.encode(), token.encode()):
            return "refresh needs a valid X-Admin-Token header."
        return None

    async def _research(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.budget.reserve():
            retry = seconds_to_utc_midnight()
            await _send_json(send, 429, envelope(
                "unavailable", "rate_limited",
                "The daily budget of new AI research jobs is used up; try again tomorrow (UTC)."),
                {"Retry-After": str(retry)})  # fmt: skip
            return
        start: Message | None = None
        chunks: list[bytes] = []

        async def capture(msg: Message) -> None:
            nonlocal start
            if msg["type"] == "http.response.start":
                start = msg
            elif msg["type"] == "http.response.body":
                chunks.append(msg.get("body", b""))

        settled = False
        try:
            await self.app(scope, receive, capture)
            raw = b"".join(chunks)
            doc: Any = None
            if start is not None and start["status"] == 200:
                try:
                    doc = json.loads(raw)
                except ValueError:
                    doc = None
            new = is_new_research_job(doc)
            self.budget.settle(doc.get("job_id") if isinstance(doc, dict) else None, new)
            settled = True
            if start is not None:
                await send(start)
            await send({"type": "http.response.body", "body": raw})
        finally:
            if not settled:
                self.budget.settle(None, False)


class HeadersMiddleware:
    def __init__(self, app: ASGIApp, production: bool | None = None) -> None:
        self.app = app
        self.production = is_production() if production is None else production

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        docs = scope["path"] in ("/docs", "/redoc", "/docs/oauth2-redirect")
        post = scope["method"] == "POST"

        async def wrapped(msg: Message) -> None:
            if msg["type"] == "http.response.start":
                hs = [(k, v) for k, v in msg.get("headers", []) if k.lower() != b"server"]
                have = {k.lower() for k, _ in hs}
                add = [(b"x-content-type-options", b"nosniff"),
                       (b"referrer-policy", b"no-referrer"),
                       (b"x-frame-options", b"DENY")]  # fmt: skip
                if not docs:  # the dev-only Swagger page loads its own scripts
                    add.append((b"content-security-policy",
                                b"default-src 'none'; frame-ancestors 'none'"))  # fmt: skip
                if self.production:
                    add.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                if post:
                    hs = [(k, v) for k, v in hs if k.lower() != b"cache-control"]
                    have.discard(b"cache-control")
                    add.append((b"cache-control", b"no-store"))
                hs += [(k, v) for k, v in add if k not in have]
                msg = {**msg, "headers": hs}
            await send(msg)

        await self.app(scope, receive, wrapped)


def cors_settings(origins: list[str], production: bool) -> list[str]:
    """Never a wildcard. In production an empty list is allowed (no browser origin can call the
    API) but logged loudly, so the deploy still starts and ``/health`` answers."""
    clean = [o for o in origins if o != "*"]
    if len(clean) != len(origins):
        log.error("ACRE_CORS_ORIGINS contains '*'; wildcards are never allowed and it was "
                  "dropped")  # fmt: skip
    if production and not clean:
        log.error("ACRE_CORS_ORIGINS is empty in production: no browser origin can call "
                  "the API until it is set")  # fmt: skip
    return clean
