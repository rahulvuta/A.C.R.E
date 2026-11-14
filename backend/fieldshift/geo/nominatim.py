"""Nominatim (OpenStreetMap) geocoding behind the backend.

Rules this module keeps:

* a **generic User-Agent** (never a person's name or address) and at most **one request per
  second**, shared by every caller in the process;
* every answer is **cached** on disk (``<cache>/geo/``), keyed by a hash, so the same question is
  never asked twice and the cache holds no query text;
* the **query text is never logged**, and reverse lookups send the point rounded to 2 decimals
  (about 1 km), not the exact field location;
* offline mode (``FIELDSHIFT_OFFLINE=1``) answers only from the cache and the committed fixtures
  in ``data/geo/geocode_fixtures.json``; it never opens a connection.

Failures are :class:`GeoError` with a ``code`` the routes turn into ``unavailable``.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from fieldshift.geo.config import GEO_DATA_DIR, cache_root, is_offline

BASE_URL = "https://nominatim.openstreetmap.org"
USER_AGENT = "acre-fieldshift/0.1"  # generic on purpose: no personal contact details
MIN_INTERVAL_S = 1.0
TIMEOUT_S = 8.0
FIXTURES_PATH = GEO_DATA_DIR / "geocode_fixtures.json"
REVERSE_DECIMALS = 2


class GeoError(RuntimeError):
    """The geocoder could not answer. ``code`` is machine-readable (see ``REASON_TEXT``)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


REASON_TEXT = {
    "geocoder_offline": "The place search is not available offline, and this place is not saved.",
    "geocoder_unreachable": "The place search service did not answer. Try again in a moment.",
    "geocoder_bad_response": "The place search service sent an answer this app could not read.",
}


def reverse_key(lat: float, lon: float) -> str:
    return f"{round(lat, REVERSE_DECIMALS):.2f},{round(lon, REVERSE_DECIMALS):.2f}"


def _normalise_query(q: str) -> str:
    return " ".join(q.casefold().split())


def _hash(*parts: Any) -> str:
    return hashlib.sha256("\x1f".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:32]


def load_fixtures(path: Path = FIXTURES_PATH) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"search": {}, "reverse": {}}
    return {"search": doc.get("search", {}), "reverse": doc.get("reverse", {})}


class Nominatim:
    """A small, polite client. One instance per process (``get_client``)."""

    def __init__(
        self,
        *,
        base_url: str = BASE_URL,
        user_agent: str = USER_AGENT,
        cache_dir: Path | None = None,
        client: httpx.Client | None = None,
        offline: Callable[[], bool] = is_offline,
        min_interval: float = MIN_INTERVAL_S,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        fixtures: dict[str, Any] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent
        self._cache_dir = cache_dir
        self._client = client
        self._offline = offline
        self._min_interval = min_interval
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._last_request = -1e9
        self._fixtures = fixtures if fixtures is not None else load_fixtures()

    # -------------------------------------------------------------- cache
    @property
    def cache_dir(self) -> Path:
        return self._cache_dir if self._cache_dir is not None else cache_root() / "geo"

    def _read_cache(self, key: str) -> Any | None:
        try:
            return json.loads((self.cache_dir / f"{key}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _write_cache(self, key: str, value: Any) -> None:
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            tmp = self.cache_dir / f"{key}.json.tmp"
            tmp.write_text(json.dumps(value), encoding="utf-8")
            tmp.replace(self.cache_dir / f"{key}.json")
        except OSError:
            pass  # a cache that cannot be written is only slower

    # -------------------------------------------------------------- http
    def _get(self, path: str, params: dict[str, Any]) -> Any:
        client = self._client or httpx.Client(timeout=TIMEOUT_S)
        with self._lock:  # one request at a time, at most one per second
            wait = self._min_interval - (self._clock() - self._last_request)
            if wait > 0:
                self._sleep(wait)
            try:
                resp = client.get(
                    f"{self.base_url}{path}",
                    params=params,
                    headers={"User-Agent": self.user_agent, "Accept-Language": "en"},
                )
            except httpx.HTTPError as exc:  # no URL or query text in the message
                raise GeoError("geocoder_unreachable", type(exc).__name__) from None
            finally:
                self._last_request = self._clock()
        if resp.status_code != 200:
            raise GeoError("geocoder_unreachable", f"HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError:
            raise GeoError("geocoder_bad_response") from None

    # -------------------------------------------------------------- search
    def search(self, q: str, limit: int = 5) -> list[dict[str, Any]]:
        """Raw Nominatim ``jsonv2`` rows for a place name (cache, fixtures, then the network)."""
        norm = _normalise_query(q)
        key = "s_" + _hash(norm, limit)
        cached = self._read_cache(key)
        if cached is not None:
            return cached
        fixture = self._fixtures["search"].get(norm)
        if fixture is not None:
            return fixture[:limit]
        if self._offline():
            raise GeoError("geocoder_offline")
        rows = self._get(
            "/search",
            {"q": q, "format": "jsonv2", "addressdetails": 1, "limit": limit,
             "accept-language": "en"},
        )  # fmt: skip
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise GeoError("geocoder_bad_response")
        self._write_cache(key, rows)
        return rows

    # -------------------------------------------------------------- reverse
    def reverse(self, lat: float, lon: float) -> dict[str, Any]:
        """The raw Nominatim ``jsonv2`` object for a point rounded to 2 decimals."""
        rk = reverse_key(lat, lon)
        key = "r_" + _hash(rk)
        cached = self._read_cache(key)
        if cached is not None:
            return cached
        fixture = self._fixtures["reverse"].get(rk)
        if fixture is not None:
            return fixture
        if self._offline():
            raise GeoError("geocoder_offline")
        rlat, rlon = (float(x) for x in rk.split(","))
        row = self._get(
            "/reverse",
            {"lat": rlat, "lon": rlon, "format": "jsonv2", "addressdetails": 1, "zoom": 10,
             "accept-language": "en"},
        )  # fmt: skip
        if not isinstance(row, dict):
            raise GeoError("geocoder_bad_response")
        if "error" in row:  # Nominatim answers 200 with an error for open water
            row = {"error": "no_result"}
        self._write_cache(key, row)
        return row


_CLIENT: Nominatim | None = None
_CLIENT_LOCK = threading.Lock()


def get_client() -> Nominatim:
    global _CLIENT
    with _CLIENT_LOCK:
        if _CLIENT is None:
            _CLIENT = Nominatim()
        return _CLIENT


def set_client(client: Nominatim | None) -> None:
    """Replace the process-wide client (tests)."""
    global _CLIENT
    with _CLIENT_LOCK:
        _CLIENT = client
