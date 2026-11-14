"""SoilGrids v2 (ISRIC) at a point (card B4): a 250 m model estimate, never a measurement.

Clay, sand, silt, soil organic carbon, pH (water) and bulk density at 0-5, 5-15 and 15-30 cm, each
the mean of the model's prediction, in plain units (%, g/kg, pH, g/cm³). Every value says
``origin: dataset_estimate`` and the resolution. Missing values (water, urban, no prediction) are
``None``, never 0.

Cached per 250 m cell: two fields in different cells get separate values, two points in one cell
share one. Points are rounded to the cell before any request or cache key; nothing is logged. A
SoilGrids outage gives ``status: unavailable`` and never affects the analysis.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field

from fieldshift.contracts import Status
from fieldshift.geo.config import cache_root, is_offline

URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
TIMEOUT_S = 20.0
CACHE_DAYS = 180  # SoilGrids is a static release; a long cache is safe
CELL_DEG = 0.0025  # ~250 m in latitude; the cache and request key
PROPERTIES = {  # SoilGrids name -> (our name, plain unit, label)
    "clay": ("clay", "%", "Clay"),
    "sand": ("sand", "%", "Sand"),
    "silt": ("silt", "%", "Silt"),
    "soc": ("soc", "g/kg", "Soil organic carbon"),
    "phh2o": ("ph_water", "pH", "pH (water)"),
    "bdod": ("bulk_density", "g/cm3", "Bulk density"),
}
DEPTHS = ("0-5cm", "5-15cm", "15-30cm")
SOURCE = {"title": "SoilGrids 2.0 (ISRIC), Poggio et al. 2021, SOIL 7, 217-240",
          "url": "https://www.isric.org/explore/soilgrids", "licence": "CC BY 4.0"}  # fmt: skip


class SoilValue(BaseModel):
    depth: str
    value: float | None
    unit: str
    origin: str = "dataset_estimate"


class SoilProperty(BaseModel):
    name: str
    label: str
    unit: str
    values: list[SoilValue]


class SoilGridsResult(BaseModel):
    status: Status  # complete | partial | unavailable
    reason: str | None = None
    provider: str = "soilgrids"
    resolution_m: int = 250
    cell: str | None = None
    properties: list[SoilProperty] = Field(default_factory=list)
    origin: str = "dataset_estimate"
    note: str = ("Model estimate on a 250 m grid (SoilGrids 2.0), not a soil test of this field. "
                 "Context only: it is never turned into a benefit or a recommendation.")  # fmt: skip
    source: dict[str, Any] = Field(default_factory=lambda: dict(SOURCE))
    freshness: str = "unavailable"
    fetched_at: str | None = None


def cell_of(lat: float, lon: float) -> tuple[float, float]:
    """The centre of the ~250 m cell holding the point (what is sent and cached)."""
    return ((math.floor(lat / CELL_DEG) + 0.5) * CELL_DEG,
            (math.floor(lon / CELL_DEG) + 0.5) * CELL_DEG)  # fmt: skip


def _cell_id(clat: float, clon: float) -> str:
    return f"sg_{clat:+.4f}_{clon:+.4f}"


def _cache_dir() -> Path:
    return cache_root() / "soilgrids"


def _cache_path(cell: str) -> Path:
    return _cache_dir() / (hashlib.sha256(cell.encode()).hexdigest()[:24] + ".json")


def parse(body: Any) -> list[SoilProperty]:
    """SoilGrids JSON -> properties in plain units. Raises ``ValueError`` on an unexpected shape."""
    layers = ((body or {}).get("properties") or {}).get("layers")
    if not isinstance(layers, list):
        raise ValueError("SoilGrids response has no layers")
    out: list[SoilProperty] = []
    for layer in layers:
        name = layer.get("name") if isinstance(layer, dict) else None
        if name not in PROPERTIES:
            continue
        ours, unit, label = PROPERTIES[name]
        factor = (layer.get("unit_measure") or {}).get("d_factor") or 1
        by_depth: dict[str, float | None] = {}
        for d in layer.get("depths") or []:
            mean = (d.get("values") or {}).get("mean")
            ok = isinstance(mean, int | float) and not isinstance(mean, bool) and math.isfinite(mean)
            by_depth[d.get("label")] = (mean / factor) if ok else None
        out.append(SoilProperty(name=ours, label=label, unit=unit, values=[
            SoilValue(depth=dp.replace("cm", " cm"), value=None if by_depth.get(dp) is None
                      else round(by_depth[dp], 2), unit=unit) for dp in DEPTHS]))  # fmt: skip
    if not out:
        raise ValueError("SoilGrids response has none of the requested properties")
    return out


def get_soilgrids(lat: float, lon: float, *, client: httpx.Client | None = None,
                  now: datetime | None = None, offline: bool | None = None) -> SoilGridsResult:  # fmt: skip
    """SoilGrids at the point's 250 m cell. Never raises."""
    now = now or datetime.now(UTC)
    offline = is_offline() if offline is None else offline
    clat, clon = cell_of(lat, lon)
    cell = _cell_id(clat, clon)
    path = _cache_path(cell)
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
        at = datetime.strptime(entry["fetched_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        if now - at <= timedelta(days=CACHE_DAYS):
            props = parse(entry["body"])
            return _result(props, cell, f"cached({entry['fetched_at']})", entry["fetched_at"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    if offline:
        return SoilGridsResult(status=Status.UNAVAILABLE, reason="offline_no_soil", cell=cell)
    params = [("lat", f"{clat:.4f}"), ("lon", f"{clon:.4f}"), ("value", "mean"),
              *[("property", p) for p in PROPERTIES], *[("depth", d) for d in DEPTHS]]  # fmt: skip
    owns = client is None
    http = client or httpx.Client(timeout=TIMEOUT_S, headers={"User-Agent": "fieldshift-backend"})
    try:
        r = http.get(URL, params=params)
        if r.status_code != 200:
            return SoilGridsResult(status=Status.UNAVAILABLE, reason="soilgrids_error", cell=cell)
        body = r.json()
        props = parse(body)
    except (httpx.HTTPError, ValueError):
        return SoilGridsResult(status=Status.UNAVAILABLE, reason="soilgrids_unreachable", cell=cell)
    finally:
        if owns:
            http.close()
    fetched = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"fetched_at": fetched, "body": body}), encoding="utf-8")
    except OSError:
        pass  # caching is an optimisation only
    return _result(props, cell, "fresh", fetched)


def _result(props: list[SoilProperty], cell: str, freshness: str, fetched: str) -> SoilGridsResult:
    values = [v.value for p in props for v in p.values]
    if all(v is None for v in values):
        return SoilGridsResult(status=Status.UNAVAILABLE, reason="no_soil_prediction", cell=cell,
                               properties=props, freshness=freshness, fetched_at=fetched)  # fmt: skip
    status = Status.COMPLETE if all(v is not None for v in values) else Status.PARTIAL
    return SoilGridsResult(status=status, cell=cell, properties=props, freshness=freshness,
                           fetched_at=fetched)  # fmt: skip


REASONS = {
    "offline_no_soil": "Offline mode, and SoilGrids has not been read for this 250 m cell.",
    "soilgrids_error": "SoilGrids returned an error.",
    "soilgrids_unreachable": "SoilGrids could not be reached.",
    "no_soil_prediction": "SoilGrids has no prediction here (water, urban or rock).",
}
