"""``POST /v1/regions/research`` and ``GET /v1/regions/research/{job_id}`` (card B3, contract §6).

Included in the field router (prefix ``/v1``). A ``location`` in the body is only used here to find
its region (country, admin1, climate class) and the crops SAGE lists for it; the coordinates are
never passed on to research.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from fieldshift.catalogs import crop_ids
from fieldshift.catalogs.regional import NC_KEY, valid_region_key
from fieldshift.report.http import invalid, issue, read_object
from fieldshift.report.meta import response_meta
from fieldshift.research import pipeline
from fieldshift.research.prompt import RegionQuery

router = APIRouter(tags=["research"])
DEFAULT_CROPS = ("maize", "soybean", "winter_wheat", "rice", "sorghum", "sunflower")


def _query_from_key(key: str, crops: tuple[str, ...]) -> RegionQuery:
    if key.startswith("koppen:"):
        return RegionQuery(key, None, None, None, None, key.split(":", 1)[1], crops)
    country = key.split("-", 1)[0]
    return RegionQuery(key, country, key if "-" in key else None, None, None, None, crops)


def _query_from_location(loc: dict[str, Any], crops: tuple[str, ...]
                         ) -> tuple[RegionQuery | None, list[dict[str, str]]]:  # fmt: skip
    from fieldshift.catalogs.regional import regional_catalog
    from fieldshift.geo.locate import describe, valid_point

    try:
        pt = valid_point(float(loc.get("latitude")), float(loc.get("longitude")))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        pt = None
    if pt is None:
        return None, [issue("location", "invalid_location",
                            "location needs latitude and longitude within range")]  # fmt: skip
    d = describe(*pt)
    if d.status == "unsupported":
        return None, [issue("location", "unsupported_location", "the point is over water")]
    key = next((k for k in d.region_keys if not k.startswith("koppen:")), None) or (
        d.region_keys[0] if d.region_keys else None)
    if key is None:
        return None, [issue("location", "region_unknown", "no region key for this point")]
    if not crops:
        cals = regional_catalog(*pt).calendars
        crops = tuple(sorted(c for c, v in cals.items() if not v.get("extrapolated")))
    place = d.place or {}
    return RegionQuery(key, place.get("country"), place.get("admin1"), place.get("admin1_name"),
                       place.get("country_name"), d.climate.koppen if d.climate else None,
                       crops, sage=_sage_windows(*pt)), []  # fmt: skip


def _sage_windows(lat: float, lon: float) -> dict[str, Any]:
    """The cell's SAGE windows, for the guardrails only (never sent to the model)."""
    from fieldshift.catalogs import sage

    try:
        cals, _ = sage.calendars_at(lat, lon)
    except sage.SageUnavailable:
        return {}
    return {c.crop_id: {"plant": c.plant.as_dict(),
                        "harvest": c.harvest.as_dict() if c.harvest else None}
            for c in cals if not c.extrapolated}  # fmt: skip


@router.post("/regions/research")
async def post_research(request: Request) -> Any:
    """Body: ``{region_key | location, crops?, refresh?, wait_s?}``. NC is never researched."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    raw_crops = body.get("crops") or []
    if not isinstance(raw_crops, list) or not all(crop_ids.is_known(c) for c in raw_crops):
        return invalid([issue("crops", "unknown_crop", "crops must be known crop ids")])
    crops = tuple(dict.fromkeys(crop_ids.canonical(c) for c in raw_crops))  # type: ignore[misc]
    wait = body.get("wait_s", 0)
    if isinstance(wait, bool) or not isinstance(wait, int | float) or not 0 <= wait <= 120:
        return invalid([issue("wait_s", "invalid_wait", "wait_s must be 0-120 seconds")])
    key = body.get("region_key")
    if isinstance(key, str):
        if not valid_region_key(key):
            return invalid([issue("region_key", "invalid_region_key",
                                  "region_key is ISO 3166 (AR, AR-B) or koppen:<class>")])  # fmt: skip
        q = _query_from_key(key, crops or DEFAULT_CROPS)
    elif isinstance(body.get("location"), dict):
        q, problems = _query_from_location(body["location"], crops)
        if q is None:
            return invalid(problems)
    else:
        return invalid([issue("region_key", "required", "send region_key or location")])
    if q.region_key == NC_KEY or q.region_key == "US" and q.admin1 == NC_KEY:
        return {"meta": response_meta(), "job_id": None, "job_status": "ready",
                "status": "complete", "region_key": NC_KEY, "reason": "verified_catalog",
                "reason_text": "North Carolina uses the verified catalog; it is not researched.",
                "profile_url": f"/v1/regions/{NC_KEY}/profile"}  # fmt: skip
    job = pipeline.start(q, refresh=bool(body.get("refresh")), wait_s=float(wait))
    return {"meta": response_meta(weather=False), **job.as_dict()}


@router.get("/regions/research/{job_id}")
def get_research(job_id: str) -> Any:
    job = pipeline.get(job_id)
    if job is None:
        return invalid([issue("job_id", "unknown_job", "no research job with this id")])
    return {"meta": response_meta(weather=False), **job.as_dict()}
