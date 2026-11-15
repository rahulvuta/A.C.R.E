"""``POST /v1/economics/estimate`` (card S3, contract §12). Included in the field router."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

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
