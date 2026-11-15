"""``POST /v1/economics/estimate`` (card S3, contract §12). Included in the field router."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from acre.catalogs.regional import valid_region_key
from acre.croplib import library
from acre.economics import research
from acre.economics.estimate import EconomicsInputError, estimate_economics
from acre.report.http import invalid, issue, read_object
from acre.report.meta import response_meta

router = APIRouter(tags=["economics"])


@router.post("/economics/estimate")
async def post_estimate(request: Request) -> Any:
    """Body: ``{location, crops, area?, equipment?, overrides?, loss_assumptions?}``."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    loc = body.get("location")
    if loc is not None and not isinstance(loc, dict):
        return invalid([issue("location", "invalid_location", "location must be an object")])
    try:
        out = estimate_economics(loc, body.get("crops"), body.get("area"),  # type: ignore[arg-type]
                                 body.get("equipment") or [], body.get("overrides"),
                                 loss_assumptions=body.get("loss_assumptions"))  # fmt: skip
    except EconomicsInputError as exc:
        return invalid([issue(exc.field, exc.code, str(exc))])
    return {"meta": response_meta(weather=False), **out}


def research_request(body: dict[str, Any]) -> tuple[tuple[str, str, bool, float] | None,
                                                   list[dict[str, str]]]:  # fmt: skip
    """``(crop_id, region_key, refresh, wait_s)`` of a research body, or the typed issues. Shared
    by economics and calendar research (a crop must be in the library; region keys are ISO)."""
    problems: list[dict[str, str]] = []
    cid = body.get("crop_id")
    crop = library.get_crop(cid) if isinstance(cid, str) and cid.strip() else None
    if crop is None:
        problems.append(issue("crop_id", "unknown_crop", "crop_id is not in the crop library; "
                              "research the crop first with POST /v1/crops/research"))  # fmt: skip
    rk = body.get("region_key")
    if not isinstance(rk, str) or not rk:
        problems.append(issue("region_key", "required", "region_key is required"))
    elif not valid_region_key(rk) or rk.startswith("koppen:"):
        problems.append(issue("region_key", "invalid_region_key",
                              "region_key is ISO 3166 (US, US-NC, AR-B)"))  # fmt: skip
    wait = body.get("wait_s", 0)
    if isinstance(wait, bool) or not isinstance(wait, int | float) or not 0 <= wait <= 120:
        problems.append(issue("wait_s", "invalid_wait", "wait_s must be 0-120 seconds"))
    if problems or crop is None:
        return None, problems
    return (crop["crop_id"], str(rk).upper(), bool(body.get("refresh")), float(wait)), []


@router.post("/economics/research")
async def post_research(request: Request) -> Any:
    """Body: ``{crop_id, region_key, refresh?, wait_s?}``. Looks up published prices, yields and
    costs for a known crop; the request to the AI carries only the crop and the region."""
    body, err = await read_object(request)
    if err is not None:
        return err
    assert body is not None
    req, problems = research_request(body)
    if req is None:
        return invalid(problems)
    cid, rk, refresh, wait = req
    job = research.start(cid, rk, refresh=refresh, wait_s=wait)
    return {"meta": response_meta(weather=False), **job.as_dict()}


@router.get("/economics/research/{job_id}")
def get_research(job_id: str) -> Any:
    job = research.get(job_id)
    if job is None:
        return invalid([issue("job_id", "unknown_job", "no economics research job with this id")])
    return {"meta": response_meta(weather=False), **job.as_dict()}
