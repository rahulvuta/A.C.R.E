"""Phase 11 tool routes: ``POST /v1/fertilizer/calc`` and ``POST /v1/irrigation/check``.

Mounted by the API app (owner: Agent A). Bad input is a 400 with typed issues and the response
metadata; calculations that cannot be done for a *valid* request (a product with none of the
requested nutrient) are 400 ``invalid_input`` with the field that caused it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from fieldshift.report.http import invalid, issue, read_object
from fieldshift.report.meta import get_index, response_meta
from fieldshift.tools.fertilizer import Product, calculate
from fieldshift.tools.irrigation import check_irrigation

router = APIRouter(prefix="/v1", tags=["tools"])

AC_PER_HA = 2.4710538146716534
KG_PER_LB = 0.45359237
KGHA_PER_LBAC = KG_PER_LB * AC_PER_HA  # 1 lb/ac = 1.12085 kg/ha
MM_PER_IN = 25.4
M3_PER_HA_MM = 10.0  # 1 mm over 1 ha = 10 m³
MAX_AREA_HA = 4_000_000.0


def _area(body: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """The field area (card B4): ``area_ha``, ``area_acres``, or ``field_id`` + ``farm`` (GeoJSON
    FeatureCollection whose features carry ``properties.field_id``; the backend measures the
    polygon). ``None`` without any: per-area values only."""
    problems: list[dict[str, str]] = []
    given = [k for k in ("area_ha", "area_acres", "field_id") if body.get(k) is not None]
    if len(given) > 1:
        return None, [issue(given[1], "conflicting_area", "give one of area_ha, area_acres or "
                            "field_id + farm")]  # fmt: skip
    if not given:
        return None, []
    key = given[0]
    if key in ("area_ha", "area_acres"):
        v = body[key]
        if isinstance(v, bool) or not isinstance(v, int | float) or not (
                0 < v <= (MAX_AREA_HA if key == "area_ha" else MAX_AREA_HA * AC_PER_HA)):  # fmt: skip
            return None, [issue(key, "bad_area", f"{key} must be a number > 0")]
        ha = float(v) if key == "area_ha" else float(v) / AC_PER_HA
        return {"ha": ha, "acres": ha * AC_PER_HA, "origin": "grower", "basis": key}, []
    fid, farm = body.get("field_id"), body.get("farm")
    feats = farm.get("features") if isinstance(farm, dict) else None
    if not isinstance(fid, str) or not isinstance(feats, list):
        return None, [issue("farm", "required", "field_id needs a farm GeoJSON FeatureCollection")]
    feat = next((f for f in feats if isinstance(f, dict) and (
        (f.get("properties") or {}).get("field_id") == fid or f.get("id") == fid)), None)  # fmt: skip
    if feat is None:
        return None, [issue("field_id", "unknown_field", "no feature in farm has this field_id")]
    try:
        from fieldshift.farms.geometry import GeometryError, parse_field
    except ImportError:  # the farm geometry module (card A3) is not present
        return None, [issue("field_id", "unsupported", "field areas need the farm API (A3)")]
    try:
        shape = parse_field(feat.get("geometry"))
    except GeometryError as exc:
        return None, [issue("farm", exc.code, str(exc))]
    return {"ha": shape.area_ha, "acres": shape.area_ha * AC_PER_HA, "origin": "calculation",
            "basis": "field geometry (geodesic area computed by the backend)"}, problems  # fmt: skip


def _units(body: dict[str, Any]) -> tuple[str | None, list[dict[str, str]]]:
    """``us`` or ``metric``: as asked, else by the location's country (metric outside the U.S.),
    else ``us`` (the NC demo)."""
    u = body.get("units")
    if u is not None:
        if u not in ("us", "metric"):
            return None, [issue("units", "invalid_units", "units must be 'us' or 'metric'")]
        return u, []
    loc = body.get("location")
    if isinstance(loc, dict):
        try:
            la, lo = float(loc["latitude"]), float(loc["longitude"])
        except (KeyError, TypeError, ValueError):
            return None, [issue("location", "invalid_location", "location needs latitude and "
                                "longitude")]  # fmt: skip
        from fieldshift.geo.locate import describe

        d = describe(la, lo, allow_network=False)
        return ("us" if d.in_nc or d.country == "US" else "metric"), []
    return "us", []


def _area_block(area: dict[str, Any] | None, units: str) -> dict[str, Any] | None:
    if area is None:
        return None
    v, u = (area["ha"], "ha") if units == "metric" else (area["acres"], "ac")
    return {"value": round(v, 4), "unit": u, "origin": area["origin"], "basis": area["basis"]}


@router.post("/fertilizer/calc")
async def post_fertilizer(request: Request) -> Any:
    """Body: ``{targets: {n_lb_per_acre, p2o5_lb_per_acre, k2o_lb_per_acre}, product: {fertilizer_id | grade},
    area_acres?, basis?, crop_id?}``. No nutrient target is ever invented."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    targets, prod = body.get("targets", {}), body.get("product", {})
    problems = []
    if not isinstance(targets, dict):
        problems.append(issue("targets", "invalid_type", "targets must be an object"))
    if not isinstance(prod, dict):
        problems.append(issue("product", "invalid_type", "product must be an object"))
    for key in ("basis", "crop_id"):
        if body.get(key) is not None and not isinstance(body[key], str):
            problems.append(issue(key, "invalid_type", f"{key} must be a string"))
    area, a_problems = _area(body)
    units, u_problems = _units(body)
    problems += a_problems + u_problems
    if problems:
        return invalid(problems)
    try:
        product = Product(**{k: v for k, v in prod.items() if k in Product.model_fields})
    except ValueError:
        return invalid([issue("product", "invalid_type", "product fields must be strings")])
    result = calculate(
        targets, product, get_index(), area_acres=area["acres"] if area else None,
        basis=body.get("basis"), crop_id=body.get("crop_id"),
    )  # fmt: skip
    if result.status == "invalid_input":
        return invalid(
            [i.model_dump() for i in result.issues],
            n_reference=result.n_reference.model_dump(mode="json") if result.n_reference else None,
            notes=result.notes,
        )
    out: dict[str, Any] = {"meta": response_meta(), "result": result.model_dump(mode="json"),
                           "units": units, "area": _area_block(area, units)}  # fmt: skip
    rate = result.product_lb_per_acre_exact
    if rate is not None:
        out["per_area"] = ({"value": round(rate * KGHA_PER_LBAC, 1), "unit": "kg/ha",
                            "origin": "calculation"} if units == "metric" else
                           {"value": result.product_lb_per_acre, "unit": "lb/ac",
                            "origin": "calculation"})  # fmt: skip
    out["field_total"] = None
    if area is not None and rate is not None:
        total_lb = rate * area["acres"]
        out["field_total"] = ({"value": round(total_lb * KG_PER_LB, 1), "unit": "kg",
                               "origin": "calculation"} if units == "metric" else
                              {"value": round(total_lb, 1), "unit": "lb",
                               "origin": "calculation"})  # fmt: skip
    return out


@router.post("/irrigation/check")
async def post_irrigation(request: Request) -> Any:
    """Body: ``{crop_id, stage?, awc_in?, start_storage_in?, weather?: [{date, precip_mm|precip_in}],
    irrigation?: [{date, amount_in}], water_table_depth_in?}``. A numeric balance is returned only
    when every input is present; otherwise ``insufficient_data`` lists what is missing."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    crop_id = body.get("crop_id")
    if not isinstance(crop_id, str) or not crop_id:
        return invalid([issue("crop_id", "required", "crop_id is required")])
    stage = body.get("stage")
    if stage is not None and not isinstance(stage, str):
        return invalid([issue("stage", "invalid_type", "stage must be a string")])
    area, problems = _area(body)
    units, u_problems = _units(body)
    if problems or u_problems:
        return invalid(problems + u_problems)
    result = check_irrigation(
        get_index(), crop_id=crop_id, stage=stage, awc_in=body.get("awc_in"),
        start_storage_in=body.get("start_storage_in"), weather=body.get("weather"),
        irrigation=body.get("irrigation"), water_table_depth_in=body.get("water_table_depth_in"),
    )  # fmt: skip
    if result.status == "invalid_input":
        return invalid([i.model_dump() for i in result.issues])
    out: dict[str, Any] = {"meta": response_meta(), "result": result.model_dump(mode="json"),
                           "units": units, "area": _area_block(area, units), "per_area": None,
                           "field_total": None}  # fmt: skip
    need = (result.supplemental_need or {}).get("unmet_demand_in")
    if need is not None:  # a depth over the field; 0 stays 0
        out["per_area"] = ({"value": round(need * MM_PER_IN, 1), "unit": "mm",
                            "origin": "calculation", "what": "unmet crop demand"}
                           if units == "metric" else
                           {"value": need, "unit": "in", "origin": "calculation",
                            "what": "unmet crop demand"})  # fmt: skip
        if area is not None:
            out["field_total"] = ({"value": round(need * MM_PER_IN * area["ha"] * M3_PER_HA_MM, 1),
                                   "unit": "m3", "origin": "calculation"} if units == "metric"
                                  else {"value": round(need * area["acres"], 2),
                                        "unit": "acre_in", "origin": "calculation"})  # fmt: skip
    return out
