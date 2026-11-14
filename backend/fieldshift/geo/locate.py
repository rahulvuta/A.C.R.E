"""Describe a point anywhere: place, climate class, hemisphere, weather cell and region keys.

This is the library behind ``GET /v1/geo/reverse``, the worldwide ``resolve_location`` and
``capabilities_for``. Rules:

* **Water and bad input.** A point whose Köppen cell and neighbours are all water is
  ``unsupported`` / ``unsupported_location``. Coordinates out of range are ``invalid_input``.
* **NC points never need the network.** Inside North Carolina the place comes from the committed
  fixtures or the NC outline, and the region (Piedmont, Coastal Plain, Mountains) from the
  existing Fall Line logic in ``field/location.py``.
* **Elsewhere** the country and first-level region (ISO 3166-2) come from Nominatim reverse
  geocoding at 2 decimals, cached on disk. If that fails, the answer is ``partial`` with the
  climate class and the ``koppen:<class>`` region key only; nothing else is guessed.
* **Region keys** for catalog lookup, most specific first: ``country-admin1`` (``AR-B``), then
  ``country`` (``AR``), then ``koppen:<class>``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from fieldshift.geo import koppen
from fieldshift.geo.nominatim import REASON_TEXT, GeoError, get_client

UNSUPPORTED_CODE = "unsupported_location"

_NC_REGION_NAMES = {"piedmont": "Piedmont", "coastal_plain": "Coastal Plain",
                    "mountains": "Mountains"}  # fmt: skip
_ADMIN2_KEYS = ("county", "state_district", "municipality", "city_district")
_NAME_KEYS = ("city", "town", "village", "hamlet", "municipality", "suburb", "county")


@dataclass
class Description:
    """Everything known about one point. ``status`` is complete | partial | unsupported."""

    status: str
    latitude: float
    longitude: float
    code: str | None = None
    reason: str | None = None
    reason_text: str | None = None
    place: dict[str, Any] = field(default_factory=dict)
    place_source: str | None = None  # nominatim | fixture | cache | nc_outline | None
    hemisphere: str | None = None
    on_land: bool | None = None
    climate: koppen.Climate | None = None
    cell_id: str | None = None
    region_keys: list[str] = field(default_factory=list)
    nc_region: str | None = None
    in_nc: bool = False

    @property
    def country(self) -> str | None:
        return self.place.get("country")

    @property
    def admin1(self) -> str | None:
        return self.place.get("admin1")

    @property
    def region_key(self) -> str | None:
        """The most specific key (``AR-B``, else ``AR``, else ``koppen:Cfa``)."""
        return self.region_keys[0] if self.region_keys else None


def hemisphere_of(lat: float) -> str:
    """``north`` for the equator and everything above it (a convention, stated in the docs)."""
    return "north" if lat >= 0 else "south"


def valid_point(lat: Any, lon: Any) -> tuple[float, float] | None:
    if isinstance(lat, bool) or isinstance(lon, bool):
        return None
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError, OverflowError):
        return None
    if not (math.isfinite(la) and math.isfinite(lo) and -90 <= la <= 90 and -180 <= lo <= 180):
        return None
    return la, lo


def _admin1_code(address: dict[str, Any], cc: str) -> str | None:
    for level in ("4", "3", "5", "6", "2"):
        code = address.get(f"ISO3166-2-lvl{level}")
        if isinstance(code, str) and code.upper().startswith(cc + "-"):
            return code.upper()
    return None


def place_from_nominatim(row: dict[str, Any]) -> dict[str, Any]:
    """The contract's ``place`` object from a Nominatim ``jsonv2`` row (``{}`` if unusable)."""
    address = row.get("address")
    if not isinstance(address, dict):
        return {}
    cc = str(address.get("country_code") or "").upper()
    if len(cc) != 2:
        return {}
    country_name = address.get("country")
    admin1_name = address.get("state") or address.get("region") or address.get("province")
    admin2_name = next((address[k] for k in _ADMIN2_KEYS if address.get(k)), None)
    name = row.get("name") or next((address[k] for k in _NAME_KEYS if address.get(k)), None)
    display_parts = [p for p in (name, admin1_name, country_name) if p]
    seen: list[str] = []
    for p in display_parts:
        if p not in seen:
            seen.append(p)
    return {
        "display": ", ".join(seen) or row.get("display_name"),
        "country": cc,
        "country_name": country_name,
        "admin1": _admin1_code(address, cc),
        "admin1_name": admin1_name,
        "admin2_name": admin2_name,
    }


def _empty_place() -> dict[str, Any]:
    return {"display": None, "country": None, "country_name": None, "admin1": None,
            "admin1_name": None, "admin2_name": None}  # fmt: skip


def _nc_place() -> dict[str, Any]:
    return {"display": "North Carolina, United States", "country": "US",
            "country_name": "United States", "admin1": "US-NC",
            "admin1_name": "North Carolina", "admin2_name": None}  # fmt: skip


def _keys(place: dict[str, Any], clim: koppen.Climate | None) -> list[str]:
    keys: list[str] = []
    if place.get("admin1"):
        keys.append(place["admin1"])
    if place.get("country"):
        keys.append(place["country"])
    if clim is not None and clim.koppen:
        keys.append(f"koppen:{clim.koppen}")
    return keys


def describe(lat: Any, lon: Any, *, allow_network: bool = True) -> Description:
    """Describe a point. Never raises; an invalid point is ``status: invalid_input``."""
    from fieldshift.field.location import approximate_region, cell_id, in_nc_bounds
    from fieldshift.weather.sources import derive_grid_cell

    pt = valid_point(lat, lon)
    if pt is None:
        return Description(
            status="invalid_input", latitude=float("nan"), longitude=float("nan"),
            code="invalid_coordinates",
            reason="latitude must be within [-90, 90] and longitude within [-180, 180]",
        )  # fmt: skip
    la, lo = pt
    d = Description(status="complete", latitude=la, longitude=lo, hemisphere=hemisphere_of(la))
    d.in_nc = in_nc_bounds(la, lo)
    try:
        d.climate = koppen.lookup(la, lo)
        d.on_land = d.climate.on_land
    except koppen.KoppenUnavailable:
        # No raster: land is decided by the NC outline alone, and the climate class is unknown.
        d.climate, d.on_land = None, (True if d.in_nc else None)
        d.status, d.reason = "partial", "climate_data_unavailable"
        d.reason_text = "The bundled climate map could not be read, so no climate class is shown."
    if d.on_land is False:
        d.status, d.code = "unsupported", UNSUPPORTED_CODE
        d.reason = "over_water"
        d.reason_text = "This point is over water. Choose a point on land."
        d.place = _empty_place()
        return d
    d.cell_id = cell_id(derive_grid_cell(la, lo))

    if d.in_nc:
        from fieldshift.geo.nominatim import reverse_key

        fixture = get_client()._fixtures["reverse"].get(reverse_key(la, lo))
        if fixture is not None:
            d.place, d.place_source = place_from_nominatim(fixture) or _nc_place(), "fixture"
        else:
            d.place, d.place_source = _nc_place(), "nc_outline"
        tag = approximate_region(la, lo)
        d.nc_region = _NC_REGION_NAMES.get(tag) if tag else None
    else:
        d.place = _empty_place()
        try:
            row = _reverse(la, lo, allow_network)
            parsed = place_from_nominatim(row) if "error" not in row else {}
            if parsed:
                d.place, d.place_source = parsed, "nominatim"
            else:
                _partial(d, "geocoder_no_result",
                         "The place search found no named place for this point.")  # fmt: skip
        except GeoError as exc:
            _partial(d, exc.code, REASON_TEXT.get(exc.code, "The place search is unavailable."))
    d.region_keys = _keys(d.place, d.climate)
    return d


def _partial(d: Description, code: str, text: str) -> None:
    if d.status == "complete":
        d.status = "partial"
    d.reason, d.reason_text = d.reason or code, d.reason_text or text


def _reverse(lat: float, lon: float, allow_network: bool) -> dict[str, Any]:
    client = get_client()
    if allow_network:
        return client.reverse(lat, lon)
    # cache and fixtures only: pretend to be offline for this one call
    from fieldshift.geo.nominatim import Nominatim

    offline_view = Nominatim(
        cache_dir=client._cache_dir, offline=lambda: True, fixtures=client._fixtures,
    )  # fmt: skip
    return offline_view.reverse(lat, lon)
