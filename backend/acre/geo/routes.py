"""Geo HTTP routes (card B1): ``/v1/geo/search``, ``/v1/geo/reverse``, ``/v1/locations/capabilities``.

Included in the field router (``acre.field.routes``, prefix ``/v1``), which the API app
already mounts, so this router itself has no prefix. Coordinates in
responses are rounded to 2 decimals. A geocoder that is down is a 200 with ``status: unavailable``
and a ``reason``; bad input is a typed 400. Query text is never logged.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from acre.geo.capabilities import capabilities_from
from acre.geo.locate import Description, describe, valid_point
from acre.geo.nominatim import REASON_TEXT, GeoError, get_client
from acre.geo.parse import CoordinateError, looks_like_coordinates, parse_coordinates
from acre.report.http import invalid, issue
from acre.report.meta import response_meta

router = APIRouter(tags=["geo"])

MAX_QUERY_CHARS = 200


def _r2(x: float | None) -> float | None:
    return None if x is None else round(x, 2)


def _point(lat: str | None, lon: str | None) -> tuple[tuple[float, float] | None, list[dict]]:
    problems: list[dict[str, str]] = []
    out: list[float] = []
    for name, raw, lo, hi in (("lat", lat, -90.0, 90.0), ("lon", lon, -180.0, 180.0)):
        if raw is None or not raw.strip():
            problems.append(issue(name, "required", f"{name} is required"))
            continue
        try:
            value = float(raw)
        except ValueError:
            problems.append(issue(name, "invalid_coordinate", f"{name} must be a number"))
            continue
        if not (lo <= value <= hi):  # also false for nan
            problems.append(issue(name, "invalid_coordinate",
                                  f"{name} must be within [{lo:g}, {hi:g}]"))  # fmt: skip
            continue
        out.append(value)
    return ((out[0], out[1]) if not problems else None), problems


def _result_label(row: dict[str, Any]) -> str:
    from acre.geo.locate import place_from_nominatim

    place = place_from_nominatim(row)
    return place.get("display") or str(row.get("display_name") or "Unnamed place")


def _search_result(row: dict[str, Any]) -> dict[str, Any] | None:
    try:
        lat, lon = float(row["lat"]), float(row["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if valid_point(lat, lon) is None:
        return None
    bbox = row.get("boundingbox")  # Nominatim: [south, north, west, east] as strings
    out_bbox = None
    try:
        s, n, w, e = (float(x) for x in bbox)  # type: ignore[union-attr]
        out_bbox = [round(w, 2), round(s, 2), round(e, 2), round(n, 2)]
    except (TypeError, ValueError):
        pass
    return {
        "label": _result_label(row),
        "latitude": round(lat, 2),
        "longitude": round(lon, 2),
        "bbox": out_bbox,
        "kind": str(row.get("addresstype") or row.get("type") or "place"),
        "source": "nominatim",
    }


@router.get("/geo/search")
def get_search(q: str | None = None, limit: str | None = None) -> Any:
    """Find a place by name, or accept coordinates (decimal or degrees-minutes-seconds)."""
    problems: list[dict[str, str]] = []
    text = (q or "").strip()
    if not text:
        problems.append(issue("q", "required", "q is required"))
    elif len(text) > MAX_QUERY_CHARS:
        problems.append(issue("q", "too_long", f"q must be at most {MAX_QUERY_CHARS} characters"))
    n = 5
    if limit is not None and limit.strip():
        try:
            n = int(limit)
        except ValueError:
            n = 0
        if not 1 <= n <= 10:
            problems.append(issue("limit", "invalid_limit", "limit must be a whole number 1-10"))
    if problems:
        return invalid(problems)

    try:
        point = parse_coordinates(text)
    except CoordinateError as exc:
        return invalid([issue("q", "invalid_coordinates", str(exc))])
    if point is not None:
        lat, lon = round(point.latitude, 2), round(point.longitude, 2)
        return {
            "meta": response_meta(),
            "status": "complete",
            "query_kind": "coordinates",
            "results": [{"label": f"{lat:.2f}, {lon:.2f}", "latitude": lat, "longitude": lon,
                         "bbox": None, "kind": "coordinates", "source": "input"}],
        }  # fmt: skip
    if looks_like_coordinates(text):  # never forward mistyped coordinates as a place query
        return invalid([issue("q", "invalid_coordinates",
                              "q looks like coordinates but could not be read as a latitude "
                              "and longitude")])  # fmt: skip
    try:
        rows = get_client().search(text, n)
    except GeoError as exc:
        return {
            "meta": response_meta(),
            "status": "unavailable",
            "query_kind": "text",
            "reason": exc.code,
            "reason_text": REASON_TEXT.get(exc.code, "The place search is unavailable."),
            "results": [],
        }
    results = [r for r in (_search_result(row) for row in rows) if r is not None]
    return {
        "meta": response_meta(),
        "status": "complete" if results else "partial",
        "query_kind": "text",
        "reason": None if results else "no_results",
        "reason_text": None if results else "No place matched. Try a nearby town or coordinates.",
        "results": results,
    }


def climate_block(d: Description) -> dict[str, Any] | None:
    if d.climate is None:
        return None
    c = d.climate
    return {"koppen": c.koppen, "label": c.label, "resolution_km": c.resolution_km,
            "source": c.source, "origin": c.origin, "coastal_neighbour": c.coastal_neighbour}  # fmt: skip


def _unsupported(d: Description) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"meta": response_meta(), "status": "unsupported", "code": d.code,
                 "reason": d.reason, "reason_text": d.reason_text},
    )  # fmt: skip


@router.get("/geo/reverse")
def get_reverse(lat: str | None = None, lon: str | None = None) -> Any:
    """Place, climate class, hemisphere, weather cell and region keys for a point."""
    pt, problems = _point(lat, lon)
    if pt is None:
        return invalid(problems)
    d = describe(*pt)
    if d.status == "unsupported":
        return _unsupported(d)
    return {
        "meta": response_meta(),
        "status": d.status,
        "reason": d.reason,
        "reason_text": d.reason_text,
        "place": {**d.place},
        "place_source": d.place_source,
        "hemisphere": d.hemisphere,
        "on_land": d.on_land,
        "climate": climate_block(d),
        "cell_id": d.cell_id,
        "region_keys": d.region_keys,
        "nc_region": d.nc_region,
    }


@router.get("/locations/capabilities")
def get_capabilities(lat: str | None = None, lon: str | None = None) -> Any:
    """What the app can do at a point: weather, catalog, soil, live weather, drought, tools."""
    pt, problems = _point(lat, lon)
    if pt is None:
        return invalid(problems)
    d = describe(*pt)
    if d.status == "unsupported":
        return _unsupported(d)
    return {"meta": response_meta(), **capabilities_from(d)}
