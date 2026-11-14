"""Open-Meteo current conditions and 7-day outlook outside the U.S. (card B4). Context only.

Like the NWS block, this is live weather: it is never an input to the historical analysis, replay
or era comparisons, and it says so. The request carries the point rounded to 0.01° (what the
response is also shown at); nothing is logged. Drought outside the U.S. is ``unavailable``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx

from fieldshift.contracts import Status
from fieldshift.field.live import DEFAULT_CACHE, LiveCache, LivePart, _cached_or_fetch, _down
from fieldshift.geo.config import is_offline

URL = "https://api.open-meteo.com/v1/forecast"
TIMEOUT_S = 10.0
SOURCE = "Open-Meteo forecast API (open-meteo.com)"
NOTE = ("Live weather from Open-Meteo, shown as context. It is never used in historical checks, "
        "replay or era comparisons.")  # fmt: skip
CURRENT = ("temperature_2m", "relative_humidity_2m", "precipitation", "wind_speed_10m")
DAILY = ("temperature_2m_max", "temperature_2m_min", "precipitation_sum",
         "precipitation_probability_max")  # fmt: skip


def parse(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict) or not isinstance(body.get("daily"), dict):
        raise ValueError("Open-Meteo returned an unexpected shape")
    cur = body.get("current") if isinstance(body.get("current"), dict) else {}
    units = body.get("current_units") or {}
    dunits = body.get("daily_units") or {}
    daily = body["daily"]
    def at(key: str, i: int) -> Any:
        col = daily.get(key)
        return col[i] if isinstance(col, list) and i < len(col) else None  # missing stays None

    days = [{"date": day, **{k: at(k, i) for k in DAILY}}
            for i, day in enumerate(daily.get("time") or [])]
    return {
        "current": {k: cur.get(k) for k in CURRENT} | {"time": cur.get("time")},
        "current_units": {k: units.get(k) for k in CURRENT},
        "daily": days[:7],
        "daily_units": {k: dunits.get(k) for k in DAILY},
        "timezone": body.get("timezone"),
    }


def get_open_meteo(lat: float, lon: float, *, client: httpx.Client | None = None,
                   now: datetime | None = None, cache: LiveCache | None = None,
                   offline: bool | None = None) -> dict[str, Any]:  # fmt: skip
    """``{status, note, provider, forecast: LivePart, alerts: LivePart, drought: LivePart}``."""
    now = now or datetime.now(UTC)
    cache = DEFAULT_CACHE if cache is None else cache
    offline = is_offline() if offline is None else offline
    rlat, rlon = round(lat, 2), round(lon, 2)
    owns = client is None
    http = client or httpx.Client(timeout=TIMEOUT_S, headers={"User-Agent": "fieldshift-backend"})

    def fetch() -> dict[str, Any]:
        r = http.get(URL, params={"latitude": f"{rlat:.2f}", "longitude": f"{rlon:.2f}",
                                  "current": ",".join(CURRENT), "daily": ",".join(DAILY),
                                  "forecast_days": 7, "timezone": "auto"})  # fmt: skip
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code} from Open-Meteo")
        return parse(r.json())

    try:
        forecast: LivePart = _cached_or_fetch("forecast", f"om:{rlat:.2f},{rlon:.2f}", SOURCE, now,
                                              cache, fetch, offline)  # fmt: skip
    finally:
        if owns:
            http.close()
    if forecast.status != Status.COMPLETE:
        forecast.reason = "open_meteo_unavailable" if not offline else "offline_no_live_weather"
    alerts = _down("none", "no_alert_provider_for_region")
    drought = _down("none", "no_drought_provider_for_region")
    return {
        "status": Status.PARTIAL if forecast.status == Status.COMPLETE else Status.UNAVAILABLE,
        "provider": "open_meteo",
        "note": NOTE,
        "origin": "dataset_estimate",  # a weather model's forecast, shown as context
        "forecast": forecast.model_dump(mode="json"),
        "alerts": alerts.model_dump(mode="json"),
        "drought": drought.model_dump(mode="json"),
    }
