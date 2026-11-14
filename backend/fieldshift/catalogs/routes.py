"""``GET /v1/regions/{region_key}/profile`` (card B2, contract §6).

Included in the field router (prefix ``/v1``), which the API app already mounts.

* With ``lat``/``lon``: the profile of the catalog at that point (its SAGE cell's calendars plus the
  region's profile), provided the region key is in that point's chain.
* Without a point: ``US-NC`` (the verified catalog) or a profile stored on disk. Calendars need a
  point (SAGE is per 0.5° cell), so a region with no stored profile is ``unavailable`` until one is
  given or researched.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from fieldshift.catalogs import crop_ids, v3
from fieldshift.catalogs.index import CatalogIndex
from fieldshift.catalogs.regional import (
    DISCLAIMER,
    NC_KEY,
    RegionalIndex,
    find_profile,
    regional_catalog,
    valid_region_key,
)
from fieldshift.geo.locate import valid_point
from fieldshift.report.http import invalid, issue
from fieldshift.report.meta import get_index, response_meta

router = APIRouter(tags=["regions"])

NC_DISCLAIMER = ("North Carolina guidance from the verified catalog (NC State Extension and other "
                 "published sources). Calendars shown for a point are SAGE estimates.")  # fmt: skip


def _rule_row(r: Any) -> dict[str, Any]:
    return {
        "rule_id": r.rule_id, "crop_id": r.crop_id, "rule_type": r.rule_type,
        "text": r.guidance or r.applies_when or "", "origin": r.origin,
        "region_key": r.region_key, "evidence_quote": r.evidence_quote,
        "source": {"title": r.source_title, "url": r.source_url, "locator": r.source_locator},
        "conflicts_with": v3.conflicts(r), "limitations": r.limitations,
    }  # fmt: skip


def _crop_row(index: CatalogIndex, crop: Any, calendar: dict[str, Any] | None) -> dict[str, Any]:
    info = crop_ids.info(crop.crop_id)
    role = (crop.crop_role or "").replace("_crop", "")
    return {"crop_id": crop.crop_id, "canonical_id": crop_ids.canonical(crop.crop_id),
            "name": crop.common_name, "roles": [role] if role else [],
            "family": crop.family or (info.family if info else None), "origin": crop.origin,
            "calendar": calendar}  # fmt: skip


def profile_body(index: CatalogIndex, region_key: str) -> dict[str, Any]:
    """The contract §6 body (without ``meta``) for a catalog."""
    regional = index if isinstance(index, RegionalIndex) else None
    in_nc = regional.in_nc if regional is not None else True
    nc_index = get_index() if in_nc else index
    cal = regional.calendar if regional is not None else (lambda _c: None)
    profile = (regional.profile if regional is not None else None) or {}
    crops = [_crop_row(nc_index, c, cal(c.crop_id)) for c in nc_index.catalog.crops
             if c.crop_role != "cover_crop"]  # fmt: skip
    covers = [{"crop_id": c.crop_id, "name": c.common_name, "origin": c.origin,
               "sources": [{"title": c.source_title, "url": c.source_url}] if c.source_url else []}
              for c in nc_index.catalog.crops if c.crop_role == "cover_crop"] if in_nc else list(
        profile.get("cover_crops") or [])  # fmt: skip
    if in_nc:
        status = "complete"
    else:
        state = regional.state() if regional is not None else {"status": "unknown"}
        status = state["status"]
    return {
        "region_key": region_key,
        "status": status,
        "origin": "verified_source" if in_nc else (regional.origin if regional else None),
        "research": profile.get("research"),
        "crops": crops,
        "cover_crops": covers,
        "rotations": list(profile.get("rotations") or []),
        "double_crops": list(profile.get("double_crops") or []),
        "rules": [_rule_row(r) for r in nc_index.catalog.rules],
        "gaps": [] if in_nc else list(regional.gaps if regional else []),
        "disclaimer": NC_DISCLAIMER if in_nc else (profile.get("disclaimer") or DISCLAIMER),
        "catalog_version": nc_index.version,
    }


def _stored_only(key: str) -> dict[str, Any] | None:
    """A stored profile without a point: its own calendars, no SAGE."""
    found = find_profile(key)
    if found is None:
        return None
    d, raw = found
    from fieldshift.catalogs.regional import clean_profile

    doc, bad = clean_profile(raw)
    if doc is None:
        return None
    rules, _ = v3.load_rules(d / "crop_rules.csv", set(crop_ids.BY_ID))
    rules = [r for r in rules if r.region_key == key]
    crops = []
    for c in doc.get("crops") or []:
        if isinstance(c, dict) and crop_ids.is_known(c.get("crop_id")):
            info = crop_ids.info(c["crop_id"])
            crops.append({"crop_id": c["crop_id"], "canonical_id": crop_ids.canonical(c["crop_id"]),
                          "name": c.get("name") or (info.name if info else None),
                          "roles": c.get("roles") or [], "family": info.family if info else None,
                          "origin": (c.get("calendar") or {}).get("origin") or doc.get("origin"),
                          "calendar": c.get("calendar")})  # fmt: skip
    return {"region_key": key, "status": "partial", "origin": doc.get("origin"),
            "research": doc.get("research"), "crops": crops,
            "cover_crops": list(doc.get("cover_crops") or []),
            "rotations": list(doc.get("rotations") or []),
            "double_crops": list(doc.get("double_crops") or []),
            "rules": [_rule_row(r) for r in rules], "gaps": [*(doc.get("gaps") or []), *bad],
            "disclaimer": doc.get("disclaimer") or DISCLAIMER, "catalog_version": None}  # fmt: skip


@router.get("/regions/{region_key}/profile")
def get_region_profile(region_key: str, lat: str | None = None, lon: str | None = None) -> Any:
    """Crops, calendars, covers, rotations and rules for a region, each with ``origin``."""
    if not valid_region_key(region_key):
        return invalid([issue("region_key", "invalid_region_key",
                              "region_key is ISO 3166 (AR, AR-B) or koppen:<class>")])  # fmt: skip
    if lat is not None or lon is not None:
        try:
            pt = valid_point(float(lat), float(lon))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            pt = None
        if pt is None:
            return invalid([issue("lat", "invalid_coordinate",
                                  "lat and lon must both be numbers within range")])  # fmt: skip
        idx = regional_catalog(*pt)
        if region_key not in idx.region_keys:
            return invalid([issue("region_key", "region_mismatch",
                                  f"this point's region keys are {idx.region_keys}")])  # fmt: skip
        meta = response_meta() if idx.in_nc else response_meta(index=idx, weather=False)
        return {"meta": meta, **profile_body(idx, region_key)}
    if region_key == NC_KEY:
        return {"meta": response_meta(), **profile_body(get_index(), NC_KEY)}
    stored = _stored_only(region_key)
    if stored is not None:
        return {"meta": {**response_meta(weather=False), "catalog_version": None}, **stored}
    return {"meta": {**response_meta(weather=False), "catalog_version": None}, "region_key": region_key, "status": "unavailable",
            "reason": "no_profile",
            "reason_text": "No profile is stored for this region. Pass lat and lon for the SAGE "
            "crop calendars of a point, or start research (POST /v1/regions/research).",
            "crops": [], "cover_crops": [], "rotations": [], "double_crops": [], "rules": [],
            "gaps": [], "disclaimer": DISCLAIMER}  # fmt: skip
