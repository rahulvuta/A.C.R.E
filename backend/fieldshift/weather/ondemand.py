"""Weather for any POWER grid cell, on demand (A1).

Lookup order for a point or a ``cell_id``:

1. the committed snapshot index (``data/snapshots/index.json``, the 8 NC counties). Committed
   snapshots always win and are never re-fetched;
2. the cache ``$FIELDSHIFT_CACHE_DIR/weather/<cell_id>/`` (default ``data/cache/``, gitignored);
3. a POWER fetch of the cell centre: same parameters, community and time standard as Phase 1,
   from 1981-01-01 to the last day on which POWER serves every parameter.

Cache layout, one directory per snapshot hash so a refresh never rewrites an old snapshot::

    weather/<cell_id>/<snapshot_hash>/   raw/, daily.parquet, manifest.json (``write_snapshot``)
    weather/<cell_id>/current.json       which hash is served, when and from what URL

A fetch is written into a temporary directory and renamed into place only when complete, so a
failure leaves nothing behind. Only one fetch per cell runs at a time in this process; a second
``prepare`` for the same cell joins the running job. ``FIELDSHIFT_OFFLINE=1`` never fetches.

The fetch always asks for the **cell centre**, never the caller's point: every point in a cell gets
the same series, and no farm coordinate is sent to POWER or written to the cache.
Nothing here logs a coordinate or a cell id.
"""

from __future__ import annotations

import calendar
import json
import logging
import math
import os
import re
import shutil
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd

from fieldshift.weather.locations import LocationEntry, cell_id_for, get_index
from fieldshift.weather.normalize import PowerFormatError, normalize_power_response
from fieldshift.weather.power_client import (
    OfflineError,
    PowerFetchError,
    RawFetch,
    fetch_daily,
    is_offline,
)
from fieldshift.weather.snapshot import (
    MANIFEST_NAME,
    PARQUET_NAME,
    REPO_ROOT,
    Snapshot,
    SnapshotError,
    load_snapshot,
    write_snapshot,
)
from fieldshift.weather.sources import (
    GRID_LAT_STEP,
    GRID_LON_STEP,
    PARAMETER_TO_COLUMN,
    SNAPSHOT_START,
    VARIABLES,
    ReferencePoint,
)

log = logging.getLogger("fieldshift.weather")

CACHE_ENV = "FIELDSHIFT_CACHE_DIR"
TIMEOUT_ENV = "FIELDSHIFT_POWER_TIMEOUT_S"
DEFAULT_CACHE_DIR = REPO_ROOT / "data" / "cache"
DEFAULT_TIMEOUT_S = 120.0
CURRENT_NAME = "current.json"

#: Coverage thresholds (plan A1): complete >= 40 complete years, insufficient_data < 15.
COMPLETE_YEARS_MIN = 40
INSUFFICIENT_YEARS_MAX = 15

CELL_NOTE = "One NASA POWER weather series covers this whole cell."

REASONS: dict[str, str] = {
    "offline_no_snapshot": (
        "The server is in offline mode and has no stored weather for this grid cell."
    ),
    "power_unreachable": "NASA POWER could not be reached. Try again later.",
    "power_error": "NASA POWER refused the request for this grid cell.",
    "power_bad_response": "NASA POWER sent a response that could not be read.",
    "power_no_data": "NASA POWER returned no complete days for this grid cell.",
    "not_prepared": (
        "No weather has been prepared for this grid cell yet; ask for it with "
        "POST /v1/weather/prepare."
    ),
    "cache_write_failed": "The weather was fetched but could not be stored on the server.",
}

JOB_READY, JOB_PENDING, JOB_FAILED = "ready", "pending", "failed"


# --------------------------------------------------------------------------- cells


_CELL_RE = re.compile(r"^cell_([+-]\d{1,2}\.\d{3})_([+-]\d{1,3}\.\d{3})$")


class CellIdError(ValueError):
    """A ``cell_id`` that is not a POWER (MERRA-2) grid cell."""


@dataclass(frozen=True)
class Cell:
    """A MERRA-2 grid cell (0.5 x 0.625 degrees) by its centre."""

    cell_id: str
    center_latitude: float
    center_longitude: float

    @classmethod
    def from_point(cls, latitude: float, longitude: float) -> Cell:
        if not (math.isfinite(latitude) and math.isfinite(longitude)
                and -90 <= latitude <= 90 and -180 <= longitude <= 180):  # fmt: skip
            raise CellIdError("latitude must be within [-90, 90] and longitude within [-180, 180]")
        return cls.parse(cell_id_for(latitude, longitude))

    @classmethod
    def parse(cls, cell_id: str) -> Cell:
        m = _CELL_RE.match(cell_id or "")
        if not m:
            raise CellIdError("cell_id must look like cell_-34.000_-60.625")
        lat, lon = float(m.group(1)) + 0.0, float(m.group(2)) + 0.0  # -0.0 -> 0.0
        lat_steps = (lat + 90.0) / GRID_LAT_STEP
        lon_steps = (lon + 180.0) / GRID_LON_STEP
        on_grid = (abs(lat_steps - round(lat_steps)) < 1e-9
                   and abs(lon_steps - round(lon_steps)) < 1e-9)  # fmt: skip
        if not (-90 <= lat <= 90 and -180 <= lon < 180 and on_grid):
            raise CellIdError("cell_id is not the centre of a POWER grid cell (0.5 x 0.625 deg)")
        cid = f"cell_{lat:+.3f}_{lon:+.3f}"
        return cls(cid, lat, lon)

    def public(self) -> dict[str, Any]:
        return {
            "center": {"latitude": self.center_latitude, "longitude": self.center_longitude},
            "size_deg": [GRID_LAT_STEP, GRID_LON_STEP],
            "note": CELL_NOTE,
        }

    def reference_point(self) -> ReferencePoint:
        return ReferencePoint(
            id=self.cell_id,
            name=f"POWER grid cell {self.cell_id}",
            latitude=self.center_latitude,
            longitude=self.center_longitude,
            basis="grid cell centre, fetched on demand; not a farm point",
        )


# --------------------------------------------------------------------------- storage


def cache_root() -> Path:
    raw = os.environ.get(CACHE_ENV, "").strip()
    return Path(raw) if raw else DEFAULT_CACHE_DIR


def cell_cache_dir(cell: Cell) -> Path:
    return cache_root() / "weather" / cell.cell_id


@dataclass(frozen=True)
class Stored:
    source: str  # committed | cache
    directory: Path
    snapshot_hash: str
    retrieved_at: str | None
    entry: LocationEntry | None = None  # the committed index row, when committed


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def stored(cell: Cell) -> Stored | None:
    """The stored weather for a cell, committed first. Reads files only."""
    entry = get_index().by_cell(cell.cell_id)
    if entry is not None:
        manifest = _read_json(entry.directory / MANIFEST_NAME) or {}
        return Stored("committed", entry.directory, entry.snapshot_hash,
                      manifest.get("retrieval", {}).get("retrieved_at"), entry)  # fmt: skip
    current = _read_json(cell_cache_dir(cell) / CURRENT_NAME)
    if not current or not isinstance(current.get("snapshot_hash"), str):
        return None
    directory = cell_cache_dir(cell) / current["snapshot_hash"]
    if not (directory / MANIFEST_NAME).exists() or not (directory / PARQUET_NAME).exists():
        return None
    return Stored("cache", directory, current["snapshot_hash"], current.get("retrieved_at"))


@lru_cache(maxsize=64)
def _load(directory: str, snapshot_hash: str) -> Snapshot:
    snap = load_snapshot(directory)
    if snap.snapshot_hash != snapshot_hash:
        raise SnapshotError("stored snapshot hash differs from its pointer")
    return snap


def load_stored(s: Stored) -> Snapshot:
    """The snapshot behind ``s``, hash-checked and loaded once per hash."""
    return _load(str(s.directory), s.snapshot_hash)


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def last_requestable_day(today: date | None = None) -> str:
    """POWER serves up to a few days ago; ask for yesterday (UTC) and trim to complete days."""
    d = (today or datetime.now(UTC).date()) - timedelta(days=1)
    return d.isoformat()


def last_complete_day(body: bytes, start: str) -> str | None:
    """The last date on which every parameter has a valid value (POWER fills recent days)."""
    daily = normalize_power_response(body, start=start).daily
    ok = daily[VARIABLES].notna().all(axis=1)
    if not ok.any():
        return None
    return pd.Timestamp(daily.loc[ok, "date"].max()).strftime("%Y-%m-%d")


class FetchFailed(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def fetch_and_store(cell: Cell, fetch: Any = None) -> Stored:
    """Fetch the cell centre from POWER, write a new snapshot, point ``current.json`` at it.

    Raises :class:`FetchFailed` with a reason code; nothing is left on disk on failure.
    """
    do_fetch = fetch or fetch_daily
    timeout = float(os.environ.get(TIMEOUT_ENV) or DEFAULT_TIMEOUT_S)
    try:
        raw: RawFetch = do_fetch(cell.center_latitude, cell.center_longitude, SNAPSHOT_START,
                                 last_requestable_day(), timeout_s=timeout, retries=1)  # fmt: skip
    except OfflineError as exc:
        raise FetchFailed("offline_no_snapshot") from exc
    except PowerFetchError as exc:
        code = "power_error" if str(exc).startswith("HTTP 4") else "power_unreachable"
        raise FetchFailed(code) from exc
    except Exception as exc:  # noqa: BLE001 - transport surprises are still "unreachable"
        raise FetchFailed("power_unreachable") from exc
    try:
        end = last_complete_day(raw.body, SNAPSHOT_START)
    except (PowerFormatError, ValueError, KeyError, TypeError) as exc:
        raise FetchFailed("power_bad_response") from exc
    if end is None:
        raise FetchFailed("power_no_data")
    base = cell_cache_dir(cell)
    tmp = base / f".tmp-{uuid.uuid4().hex}"
    created: Path | None = None
    try:
        base.mkdir(parents=True, exist_ok=True)
        manifest = write_snapshot(raw, tmp, point=cell.reference_point(),
                                  start=SNAPSHOT_START, end=end)  # fmt: skip
        h = manifest["hashes"]["snapshot_hash"]
        final = base / h
        if final.exists():
            shutil.rmtree(tmp)  # same data as a stored snapshot: keep the old files untouched
        else:
            os.rename(tmp, final)
            created = final
        previous = _read_json(base / CURRENT_NAME) or {}
        history = [*previous.get("history", [])]
        if previous.get("snapshot_hash") and previous["snapshot_hash"] != h:
            history.append({k: previous.get(k) for k in ("snapshot_hash", "retrieved_at")})
        _write_json_atomic(base / CURRENT_NAME, {
            "cell_id": cell.cell_id,
            "snapshot_hash": h,
            "retrieved_at": raw.retrieved_at,
            "source_url": raw.url,
            "last_complete_day": end,
            "history": history,
        })  # fmt: skip
    except Exception as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        if created is not None:  # never leave a snapshot that current.json does not point at
            shutil.rmtree(created, ignore_errors=True)
        log.error("weather cache write failed: %s", type(exc).__name__)
        raise FetchFailed("cache_write_failed") from exc
    return Stored("cache", base / h, h, raw.retrieved_at)


# --------------------------------------------------------------------------- coverage


def coverage_for(snap: Snapshot) -> dict[str, Any]:
    """Per-cell coverage: dates, complete calendar years, missing days per POWER parameter."""
    daily = snap.daily
    first = pd.Timestamp(daily["date"].min())
    last = pd.Timestamp(daily["date"].max())
    ok = daily[VARIABLES].notna().all(axis=1)
    years = daily["date"].dt.year
    per_year = pd.DataFrame({"year": years, "ok": ok}).groupby("year")["ok"].agg(["all", "size"])
    full_len = {y: 366 if calendar.isleap(int(y)) else 365 for y in per_year.index}
    complete_years = int(sum(1 for y, row in per_year.iterrows()
                             if row["all"] and row["size"] == full_len[y]))  # fmt: skip
    if complete_years >= COMPLETE_YEARS_MIN:
        status = "complete"
    elif complete_years < INSUFFICIENT_YEARS_MAX:
        status = "insufficient_data"
    else:
        status = "partial"
    col_to_param = {c: p for p, c in PARAMETER_TO_COLUMN.items()}
    return {
        "first_date": first.strftime("%Y-%m-%d"),
        "last_date": last.strftime("%Y-%m-%d"),
        "complete_years": complete_years,
        # These depend on a plan's dates; each analysis reports them (coverage.available_years).
        "complete_pre_plant_windows": None,
        "complete_off_seasons": None,
        "missing_days": {col_to_param[c]: int(daily[c].isna().sum()) for c in VARIABLES},
        "status": status,
        "basis": (
            f"complete year = a calendar year with every parameter on every day; complete >= "
            f"{COMPLETE_YEARS_MIN} years, insufficient_data < {INSUFFICIENT_YEARS_MAX}"
        ),
    }


# --------------------------------------------------------------------------- jobs


@dataclass
class WeatherState:
    """What ``prepare`` and ``GET /v1/weather/{cell_id}`` report for one cell."""

    cell: Cell
    job_status: str
    status: str
    reason: str | None = None
    source: str | None = None
    stored: Stored | None = None
    coverage: dict[str, Any] | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def snapshot_hash(self) -> str | None:
        return self.stored.snapshot_hash if self.stored else None

    def public(self) -> dict[str, Any]:
        return {
            "cell_id": self.cell.cell_id,
            "job_status": self.job_status,
            "status": self.status,
            "reason": self.reason,
            "reason_text": REASONS.get(self.reason) if self.reason else None,
            "source": self.source,
            "snapshot_hash": self.snapshot_hash,
            "retrieved_at": self.stored.retrieved_at if self.stored else None,
            "cell": self.cell.public(),
            "coverage": self.coverage,
            "poll": f"/v1/weather/{self.cell.cell_id}" if self.job_status == JOB_PENDING else None,
            "notes": self.notes,
        }


@dataclass
class _Job:
    future: Future


_LOCK = threading.Lock()
_JOBS: dict[str, _Job] = {}
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="power-fetch")
_FETCH_OVERRIDE: list[Any] = []  # tests install a fake POWER here (``set_fetch``)


def set_fetch(fetch: Any | None) -> None:
    """Replace the POWER fetch function (tests and the smoke script's mocked POWER)."""
    _FETCH_OVERRIDE.clear()
    if fetch is not None:
        _FETCH_OVERRIDE.append(fetch)


def reset_jobs() -> None:
    """Forget finished and running jobs (tests)."""
    with _LOCK:
        _JOBS.clear()
    _load.cache_clear()


def _ready(cell: Cell, s: Stored, source: str, notes: list[str] | None = None) -> WeatherState:
    cov = coverage_for(load_stored(s))
    return WeatherState(cell, JOB_READY, cov["status"], source=source, stored=s, coverage=cov,
                        notes=notes or [])  # fmt: skip


def _failed(cell: Cell, reason: str) -> WeatherState:
    return WeatherState(cell, JOB_FAILED, "unavailable", reason=reason)


def _from_job(cell: Cell, job: _Job) -> WeatherState:
    exc = job.future.exception()
    if exc is None:
        return _ready(cell, job.future.result(), "fetched")
    return _failed(cell, exc.reason if isinstance(exc, FetchFailed) else "power_unreachable")


def _run(cell: Cell) -> Stored:
    fetch = _FETCH_OVERRIDE[0] if _FETCH_OVERRIDE else None
    return fetch_and_store(cell, fetch)


def prepare(cell: Cell, *, refresh: bool = False, wait_s: float = 0.0) -> WeatherState:
    """Make weather for ``cell`` available. Returns at once (``pending``) unless ``wait_s``."""
    notes: list[str] = []
    with _LOCK:
        job = _JOBS.get(cell.cell_id)
        if job is None or job.future.done():
            s = stored(cell)
            if s is not None and s.source == "committed":
                if refresh:
                    notes.append("Committed snapshots are never re-fetched; refresh was ignored.")
                return _ready(cell, s, "committed", notes)
            if s is not None and not refresh:
                return _ready(cell, s, "cache")
            if is_offline():
                if s is not None:
                    notes.append("Offline mode: the stored snapshot was kept; refresh needs the "
                                 "network.")  # fmt: skip
                    return _ready(cell, s, "cache", notes)
                return _failed(cell, "offline_no_snapshot")
            job = _Job(_EXECUTOR.submit(_run, cell))
            _JOBS[cell.cell_id] = job
    if wait_s > 0:
        try:
            job.future.exception(timeout=wait_s)
        except FutureTimeout:
            pass
    if job.future.done():
        return _from_job(cell, job)
    return WeatherState(cell, JOB_PENDING, "unknown", notes=notes)


def current(cell: Cell) -> WeatherState:
    """The state of a cell without starting anything (``GET /v1/weather/{cell_id}``)."""
    with _LOCK:
        job = _JOBS.get(cell.cell_id)
    if job is not None and not job.future.done():
        return WeatherState(cell, JOB_PENDING, "unknown")
    if job is not None and job.future.exception() is not None:
        st = _from_job(cell, job)  # the latest fetch failed: say so, even over an older snapshot
        if stored(cell) is not None:
            st.notes.append("An earlier stored snapshot of this cell is still used for analysis; "
                            "the latest fetch failed.")  # fmt: skip
        return st
    s = stored(cell)
    if s is not None:
        return _ready(cell, s, s.source)
    if job is not None:
        return _from_job(cell, job)
    return _failed(cell, "offline_no_snapshot" if is_offline() else "not_prepared")


def capability(latitude: float, longitude: float) -> dict[str, Any]:
    """The ``features.weather`` block of ``/v1/locations/capabilities`` (for B1). Starts nothing.

    POWER daily values are MERRA-2 reanalysis, so the origin is ``nasa_modeled``.
    """
    cell = Cell.from_point(latitude, longitude)
    st = current(cell)
    return {
        "status": st.status,
        "job_status": st.job_status,
        "cell_id": cell.cell_id,
        "source": st.source,
        "reason": st.reason,
        "reason_text": REASONS.get(st.reason) if st.reason else None,
        "origin": "nasa_modeled",
    }
