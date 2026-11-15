"""Crop library routes (card S4, contract §13). Included in the field router (prefix ``/v1``)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from acre.catalogs.regional import NC_KEY, valid_region_key
from acre.croplib import calendar_research, library, research
from acre.economics.routes import research_request
from acre.report.http import invalid, issue, read_object
from acre.report.meta import response_meta

router = APIRouter(tags=["crop library"])


def _region(region_key: str | None) -> tuple[str | None, list[dict[str, str]]]:
    if region_key is None or region_key == "":
        return None, []
    if not valid_region_key(region_key):
        return None, [issue("region_key", "invalid_region_key",
                            "region_key is ISO 3166 (US, US-NC) or koppen:<class>")]  # fmt: skip
    return region_key, []


@router.get("/crops/search")
def get_search(q: str = "", region_key: str | None = None) -> Any:
    rk, problems = _region(region_key)
    if problems:
        return invalid(problems)
    if len(q) > 60:
        return invalid([issue("q", "invalid_query", "q is at most 60 characters")])
    results = library.search(q, rk)
    return {"meta": response_meta(weather=False), "results": results,
            "can_research": bool(q.strip()) and research.NAME_RE.match(q.strip()) is not None,
            "research_note": "Not listed? Research it: AI looks up published guidance for this "
            "region. Results are marked as AI-found and unverified."}  # fmt: skip


def _sage_windows(loc: Any) -> dict[str, Any]:
    """The SAGE windows of a location's cell, for the cross-check only (never sent anywhere)."""
    if not isinstance(loc, dict):
        return {}
    try:
        lat, lon = float(loc.get("latitude")), float(loc.get("longitude"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {}
    from acre.research.routes import _sage_windows as windows

    return windows(lat, lon)


@router.post("/crops/research")
async def post_research(request: Request) -> Any:
    """Body: ``{name, region_key, location?, refresh?, wait_s?}``. Only the name and region are
    researched; a location only selects the SAGE cell for the cross-check."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    name = body.get("name")
    problems = []
    if not isinstance(name, str) or not research.NAME_RE.match(name.strip()):
        problems.append(issue("name", "invalid_name", "name is 2-60 letters, spaces or hyphens"))
    rk, rp = _region(body.get("region_key") if isinstance(body.get("region_key"), str) else "")
    problems += rp
    if rk is None and not rp:
        problems.append(issue("region_key", "required", "region_key is required"))
    wait = body.get("wait_s", 0)
    if isinstance(wait, bool) or not isinstance(wait, int | float) or not 0 <= wait <= 120:
        problems.append(issue("wait_s", "invalid_wait", "wait_s must be 0-120 seconds"))
    if problems:
        return invalid(problems)
    assert isinstance(name, str) and rk is not None
    job = research.start(name, rk.upper() if not rk.startswith("koppen:") else rk,
                         sage=_sage_windows(body.get("location")),
                         refresh=bool(body.get("refresh")), wait_s=float(wait))  # fmt: skip
    out = {"meta": response_meta(weather=False), **job.as_dict()}
    if rk.upper() == NC_KEY:
        out["note"] = ("North Carolina's verified catalog has no rules for this crop; a researched "
                       "crop is marked as AI-found.")  # fmt: skip
    return out


@router.get("/crops/research/{job_id}")
def get_research(job_id: str) -> Any:
    job = research.get(job_id)
    if job is None:
        return invalid([issue("job_id", "unknown_job", "no crop research job with this id")])
    out = {"meta": response_meta(weather=False), **job.as_dict()}
    if job.job_status == "ready" and job.crop_id:
        out["crop"] = library.get_crop(job.crop_id, job.region_key)
    return out


@router.post("/calendars/research")
async def post_calendar_research(request: Request) -> Any:
    """Body: ``{crop_id, region_key, location?, refresh?, wait_s?}``. Looks up the usual planting
    and harvest windows of a known crop; a location only selects the SAGE cell for the cross-check
    and is never sent to the AI."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    req, problems = research_request(body)
    if req is None:
        return invalid(problems)
    cid, rk, refresh, wait = req
    job = calendar_research.start(cid, rk, sage=_sage_windows(body.get("location")),
                                  refresh=refresh, wait_s=wait)  # fmt: skip
    return {"meta": response_meta(weather=False), **job.as_dict()}


@router.get("/calendars/research/{job_id}")
def get_calendar_research(job_id: str) -> Any:
    job = calendar_research.get(job_id)
    if job is None:
        return invalid([issue("job_id", "unknown_job", "no calendar research job with this id")])
    return {"meta": response_meta(weather=False), **job.as_dict()}


@router.get("/crops/{crop_id}")
def get_crop(crop_id: str, region_key: str | None = None) -> Any:
    rk, problems = _region(region_key)
    if problems:
        return invalid(problems)
    crop = library.get_crop(crop_id, rk)
    if crop is None:
        return invalid([issue("crop_id", "unknown_crop", "no crop with this id in the library")])
    return {"meta": response_meta(weather=False), **crop}
