"""What Field Shift can do at a point: ``capabilities_for(lat, lon)`` (library call for A3).

Each feature says its status (the nine-word vocabulary), where it comes from and an ``origin``:

* **weather**: delegated to card A1 (``fieldshift.weather.ondemand.capability``): committed
  snapshot, cached cell, a running or failed fetch, or ``not_prepared``. Origin ``nasa_modeled``
  (POWER daily values are MERRA-2 reanalysis).
* **catalog**: North Carolina is the verified v2 catalog. Elsewhere it is the region profile if one
  exists (its own ``origin``), otherwise SAGE crop calendars as ``dataset_estimate``. NC rules are
  never offered outside NC.
* **soil**: USDA SDA in the U.S.; SoilGrids elsewhere (a 250 m model estimate).
* **live_weather**: NWS in the U.S.; Open-Meteo elsewhere (context only, never analysis input).
* **drought**: the U.S. Drought Monitor in the U.S., otherwise ``unavailable``.
* **tools**: irrigation and fertilizer calculators.
"""

from __future__ import annotations

import json
from typing import Any

from fieldshift.geo.config import BACKEND_ROOT
from fieldshift.geo.locate import Description, describe

REGION_PROFILE_DIR = BACKEND_ROOT / "data" / "catalogs" / "regions"
NC_KEY = "US-NC"


def _weather(d: Description) -> dict[str, Any]:
    """Card A1's own view of the cell (committed snapshot, cache, job state). Starts nothing."""
    try:
        from fieldshift.weather.ondemand import capability

        return capability(d.latitude, d.longitude)
    except Exception:  # noqa: BLE001 - weather state must never break the capabilities call
        return {"status": "unknown", "job_status": None, "cell_id": d.cell_id, "source": None,
                "reason": "weather_state_unreadable",
                "reason_text": "The weather store could not be read for this cell.",
                "origin": "nasa_modeled"}  # fmt: skip


def _profile_origin(key: str) -> str | None:
    """The origin recorded in a region profile on disk, if there is one."""
    try:
        doc = json.loads((REGION_PROFILE_DIR / key / "profile.json").read_text(encoding="utf-8"))
        origin = doc.get("origin")
        return origin if isinstance(origin, str) else None
    except (OSError, ValueError):
        return None


def _catalog(d: Description) -> dict[str, Any]:
    if d.in_nc:
        return {"status": "complete", "origin": "verified_source", "region_key": NC_KEY,
                "reason_text": "North Carolina guidance from the verified catalog."}  # fmt: skip
    for key in d.region_keys:
        origin = _profile_origin(key)
        if origin:
            return {"status": "partial", "origin": origin, "region_key": key,
                    "reason_text": "Suggestions for this region; check them with a local adviser."}  # fmt: skip
    return {"status": "partial", "origin": "dataset_estimate", "region_key": d.region_key,
            "reason_text": "Only gridded crop-calendar estimates (SAGE) are available here; "
            "there is no verified local guidance."}  # fmt: skip


def _soil(country: str | None) -> dict[str, Any]:
    if country == "US":
        return {"status": "complete", "provider": "usda_sda", "resolution_m": None,
                "origin": "verified_source"}  # fmt: skip
    return {"status": "complete", "provider": "soilgrids", "resolution_m": 250,
            "origin": "dataset_estimate"}  # fmt: skip


def _live(country: str | None) -> dict[str, Any]:
    return {"status": "complete", "provider": "nws" if country == "US" else "open_meteo"}


def _drought(country: str | None) -> dict[str, Any]:
    if country == "US":
        return {"status": "complete", "provider": "usdm"}
    if country is None:
        return {"status": "unavailable", "provider": None, "reason": "region_unknown",
                "reason_text": "The country could not be determined, so no drought monitor "
                "is shown."}  # fmt: skip
    return {"status": "unavailable", "provider": None, "reason": "no_provider_for_region",
            "reason_text": "No drought monitor is connected for this country."}  # fmt: skip


def capabilities_from(d: Description) -> dict[str, Any]:
    """The capabilities block for an already-described point."""
    if d.status in ("invalid_input", "unsupported"):
        return {"status": d.status, "code": d.code, "reason": d.reason,
                "reason_text": d.reason_text, "region_key": None, "features": None}  # fmt: skip
    country = d.country or ("US" if d.in_nc else None)
    features = {
        "weather": _weather(d),
        "catalog": _catalog(d),
        "soil": _soil(country),
        "live_weather": _live(country),
        "drought": _drought(country),
        "tools": {
            "irrigation": "complete",
            "fertilizer": "complete" if country == "US" else "partial",
        },
    }
    return {
        "status": "complete" if d.status == "complete" else "partial",
        "reason": d.reason,
        "reason_text": d.reason_text,
        "region_key": NC_KEY if d.in_nc else d.region_key,
        "region_keys": ([NC_KEY, "US", *[k for k in d.region_keys if k.startswith("koppen:")]]
                        if d.in_nc else d.region_keys),
        "features": features,
    }  # fmt: skip


def capabilities_for(lat: float, lon: float, *, allow_network: bool = True) -> dict[str, Any]:
    """Capabilities at a point (library call; the HTTP route wraps it). Never raises.

    Without a usable country (geocoder down) the soil/live/drought providers fall back to the
    non-U.S. ones and ``status`` is ``partial`` with the reason, because a U.S. point cannot be
    told from an unknown one without it. U.S. points in North Carolina never need the geocoder.
    """
    return capabilities_from(describe(lat, lon, allow_network=allow_network))
