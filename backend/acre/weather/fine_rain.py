"""Rain on a finer grid, shown beside the 50 km record (card 30).

The simulation uses NASA POWER's MERRA-2 rain (``PRECTOTCORR``), one series for a cell about 50 km
across. NASA POWER also serves the GPM IMERG satellite rain product (``IMERG_PRECTOT``) on a
0.1 x 0.1 degree grid, about 10 km, with no login. For the 0.1-degree square that holds a field
this module gives the yearly totals of both, side by side, for the years both have.

Rules kept here:

* Nothing in this module feeds the simulation. It is a second view of the same place, and the
  answer says so (``note``).
* The fetch asks for the **centre of the 0.1-degree square**, never the caller's point, so no
  farm coordinate is sent to POWER or written to the cache. Nothing here logs a coordinate.
* The 50 km totals come from the field's own stored weather record (the one the simulation
  uses). If that record is not stored yet, POWER's value for the fine square's centre is used
  only when that centre lies in the same 50 km cell; otherwise the 50 km column stays blank.
* A year counts only when at least ``MIN_DAYS`` of its days have a value. Totals are the sum of
  the days that have one; nothing is filled in or scaled up.
* The 50 km totals are sums over local-solar-time days and the 10 km totals over UTC days (the
  only standard POWER serves IMERG on). Over a year the difference is a few hours of rain at each
  end; it is stated in ``coarse.note``.
* ``ACRE_OFFLINE=1`` never fetches.

Cache: ``$ACRE_CACHE_DIR/fine_rain/<square id>.json`` (yearly totals only). It is fetched again
when the last complete calendar year is not in it.
"""

from __future__ import annotations

import json
import logging
import math
import threading
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from acre.weather import ondemand
from acre.weather.power_client import OfflineError, PowerFetchError, RawFetch, fetch_daily

log = logging.getLogger(__name__)

FINE_STEP = 0.1  # degrees, the IMERG grid
FINE_KM = 10
START = "1998-01-01"  # POWER serves IMERG_PRECTOT from 1998
FINE_PARAM = "IMERG_PRECTOT"
COARSE_PARAM = "PRECTOTCORR"
MIN_DAYS = 360
MIN_YEARS = 5
FILL = -900.0
NOTE = ("Shown beside the 50 km record for comparison. The 10-year outlook still uses the 50 km "
        "record; this does not change any result.")  # fmt: skip
FINE_SOURCE = "NASA GPM IMERG satellite rain, through NASA POWER"
COARSE_SOURCE = "NASA POWER (MERRA-2, bias-corrected), the record the 10-year outlook uses"

_LOCK = threading.Lock()
_FETCH_OVERRIDE: list[Any] = []


def set_fetch(fetch: Any | None) -> None:
    """Replace the POWER fetch function (tests)."""
    _FETCH_OVERRIDE.clear()
    if fetch is not None:
        _FETCH_OVERRIDE.append(fetch)


def fine_square(latitude: float, longitude: float) -> tuple[str, float, float]:
    """The 0.1-degree square that holds a point: its id and its centre."""
    if not (math.isfinite(latitude) and math.isfinite(longitude)
            and -90 <= latitude <= 90 and -180 <= longitude <= 180):  # fmt: skip
        raise ValueError("latitude must be within [-90, 90] and longitude within [-180, 180]")
    # work in whole tenths of a degree so 1.05 never becomes 1.0499999
    i = min(math.floor(round(latitude * 1e6) / 1e5), 899)
    j = min(math.floor(round(longitude * 1e6) / 1e5), 1799)
    lat, lon = (i * 10 + 5) / 100, (j * 10 + 5) / 100
    return f"fine_{lat:+.2f}_{lon:+.2f}", lat, lon


def yearly_totals(body: bytes) -> dict[int, dict[str, tuple[float, int]]]:
    """``{year: {parameter: (sum of valid days in mm, number of valid days)}}`` of a POWER answer."""
    doc = json.loads(body)
    params = doc.get("properties", {}).get("parameter", {})
    out: dict[int, dict[str, tuple[float, int]]] = defaultdict(dict)
    for name in (FINE_PARAM, COARSE_PARAM):
        acc: dict[int, list[float]] = defaultdict(lambda: [0.0, 0])
        for day, v in (params.get(name) or {}).items():
            if isinstance(v, int | float) and math.isfinite(v) and v > FILL and v >= 0:
                a = acc[int(str(day)[:4])]
                a[0] += float(v)
                a[1] += 1
        for year, (total, n) in acc.items():
            out[year][name] = (total, int(n))
    return dict(out)


def _stored_coarse(cell: ondemand.Cell) -> dict[int, tuple[float, int]] | None:
    """Yearly rain of the field's own stored 50 km record, or None when it is not stored."""
    s = ondemand.stored(cell)
    if s is None:
        return None
    try:
        daily = ondemand.load_stored(s).daily
    except Exception:  # noqa: BLE001 - an unreadable record is "not stored" for this view
        return None
    col = daily[["date", "precip_mm"]].dropna()
    years = col["date"].astype("datetime64[ns]").dt.year
    grouped = col.groupby(years)["precip_mm"].agg(["sum", "count"])
    return {int(y): (float(r["sum"]), int(r["count"])) for y, r in grouped.iterrows()}


def _cache_path(square_id: str) -> Path:
    return ondemand.cache_root() / "fine_rain" / f"{square_id}.json"


def _last_full_year(today: date | None = None) -> int:
    # POWER lags by a few days; a year is complete once a week of the next one has passed
    return ((today or datetime.now(UTC).date()) - timedelta(days=7)).year - 1


def _read_cache(square_id: str) -> dict[str, Any] | None:
    try:
        doc = json.loads(_cache_path(square_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or not isinstance(doc.get("years"), dict):
        return None
    return doc if str(_last_full_year()) in doc["years"] else None


def _write_cache(square_id: str, doc: dict[str, Any]) -> None:
    path = _cache_path(square_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _fetch(square_id: str, lat: float, lon: float) -> dict[str, Any]:
    """Yearly totals for the square from POWER, cached. Raises ``OfflineError``/``PowerFetchError``."""
    with _LOCK:
        cached = _read_cache(square_id)
        if cached is not None:
            return cached
        do_fetch = _FETCH_OVERRIDE[0] if _FETCH_OVERRIDE else fetch_daily
        end = (datetime.now(UTC).date() - timedelta(days=1)).isoformat()
        # IMERG is served on UTC days only (POWER answers every day as missing on local solar time).
        raw: RawFetch = do_fetch(lat, lon, START, end, parameters=[FINE_PARAM, COARSE_PARAM],
                                 time_standard="UTC", timeout_s=60.0, retries=1)  # fmt: skip
        years = yearly_totals(raw.body)
        if not any(FINE_PARAM in p for p in years.values()):
            # an answer with no fine rain at all is not kept: the next request asks again
            return {"retrieved_at": raw.retrieved_at, "years": {}}
        doc = {"retrieved_at": raw.retrieved_at,
               "years": {str(y): {k: [round(v[0], 1), v[1]] for k, v in p.items()}
                         for y, p in sorted(years.items())}}  # fmt: skip
        _write_cache(square_id, doc)
        return doc


def _unavailable(square: dict[str, Any], reason: str, text: str) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason, "reason_text": text, "fine": square,
            "coarse": None, "years": [], "summary": None, "note": NOTE, "retrieved_at": None}  # fmt: skip


def compare(latitude: float, longitude: float) -> dict[str, Any]:
    """Yearly rain of the 10 km square beside the 50 km record, for the years both have."""
    square_id, lat, lon = fine_square(latitude, longitude)
    cell = ondemand.Cell.from_point(latitude, longitude)
    square = {"source": FINE_SOURCE, "parameter": FINE_PARAM, "origin": "nasa_measured",
              "about_km": FINE_KM, "size_deg": [FINE_STEP, FINE_STEP],
              "center": {"latitude": lat, "longitude": lon}}  # fmt: skip
    try:
        doc = _fetch(square_id, lat, lon)
    except OfflineError:
        return _unavailable(square, "offline", "The service is offline, so the finer rain "
                            "record cannot be fetched.")  # fmt: skip
    except PowerFetchError:
        return _unavailable(square, "power_unreachable", "NASA POWER could not be reached for "
                            "the finer rain record. Try again later.")  # fmt: skip
    except Exception:  # noqa: BLE001 - never a coordinate in the log
        log.exception("fine rain fetch failed")
        return _unavailable(square, "power_unreachable", "NASA POWER could not be reached for "
                            "the finer rain record. Try again later.")  # fmt: skip

    stored = _stored_coarse(cell)
    same_cell = ondemand.Cell.from_point(lat, lon).cell_id == cell.cell_id
    last = _last_full_year()
    rows: list[dict[str, Any]] = []
    for key, p in sorted(doc["years"].items()):
        year = int(key)
        if year > last:
            continue
        fine = p.get(FINE_PARAM)
        if not fine or fine[1] < MIN_DAYS:
            continue
        if stored is not None:
            c = stored.get(year)
        else:
            c = tuple(p[COARSE_PARAM]) if same_cell and p.get(COARSE_PARAM) else None
        coarse = round(c[0], 1) if c and c[1] >= MIN_DAYS else None
        rows.append({"year": year, "fine_mm": round(fine[0], 1), "coarse_mm": coarse})
    both = [r for r in rows if r["coarse_mm"] is not None]
    coarse_info = {"source": COARSE_SOURCE, "parameter": COARSE_PARAM, "origin": "nasa_modeled",
                   "about_km": 50, "size_deg": cell.public()["size_deg"], "cell_id": cell.cell_id,
                   "note": "Yearly totals; its days run on local solar time and the 10 km record's "
                           "on UTC, which shifts a few hours of rain at each end of a year.",
                   "from": "stored_record" if stored is not None else
                           ("power_same_cell" if same_cell else None)}  # fmt: skip
    if len(rows) < MIN_YEARS:
        out = _unavailable(square, "insufficient_data", "The finer rain record has too few "
                           "complete years for this square.")  # fmt: skip
        return {**out, "status": "insufficient_data"}
    fine_mean = sum(r["fine_mm"] for r in (both or rows)) / len(both or rows)
    summary: dict[str, Any] = {
        "years": len(both or rows), "first_year": (both or rows)[0]["year"],
        "last_year": (both or rows)[-1]["year"], "fine_mean_mm": round(fine_mean, 0),
        "coarse_mean_mm": None, "difference_pct": None, "years_fine_lower": None,
        "origin": "calculation"}  # fmt: skip
    status, reason, text = "complete", None, None
    if len(both) >= MIN_YEARS:
        coarse_mean = sum(r["coarse_mm"] for r in both) / len(both)
        summary["coarse_mean_mm"] = round(coarse_mean, 0)
        summary["years_fine_lower"] = sum(1 for r in both if r["fine_mm"] < r["coarse_mm"])
        if coarse_mean > 0:
            summary["difference_pct"] = round((fine_mean - coarse_mean) / coarse_mean * 100, 0)
    else:
        status, reason = "partial", "no_coarse_record"
        text = ("The 50 km record for this field is not stored yet, so only the finer record is "
                "shown. It is fetched when you run your plan.")  # fmt: skip
    return {"status": status, "reason": reason, "reason_text": text, "fine": square,
            "coarse": coarse_info, "years": rows, "summary": summary, "note": NOTE,
            "retrieved_at": doc.get("retrieved_at")}  # fmt: skip
