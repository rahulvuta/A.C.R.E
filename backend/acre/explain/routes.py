"""``POST /v1/explain``: a simulation's figures in plain words, written by a model (card 26).

Body: ``{"facts": {"dry_years": "2", "years": "10", "rain_bare": "725 mm", "money_year":
"KES 331,552"}, "flags": ["money_uses_loss_estimate"], "crops": ["maize", "dry_beans"]}``.
Answer: ``{"status", "text": str | null, "origin": "ai_suggested", "model", "numbers_allowed",
"code", "reason_text", "meta"}``. ``text`` is null unless it passed every check in
:func:`acre.explain.service.check`; the page then keeps its own sentences.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from acre.explain import service
from acre.report.http import invalid, issue, read_object
from acre.report.meta import response_meta

router = APIRouter(prefix="/v1", tags=["explain"])


@router.post("/explain")
async def explain(request: Request) -> JSONResponse:
    body, bad = await read_object(request)
    if bad is not None or body is None:
        return bad  # type: ignore[return-value]
    extra = sorted(set(body) - {"facts", "flags", "crops"})
    if extra:
        return invalid([issue(extra[0], "unknown_field", "only facts, flags and crops are read")])
    cleaned = service.clean_request(body.get("facts"), body.get("flags"), body.get("crops"))
    if isinstance(cleaned, str):
        return invalid([issue("facts", "bad_facts", cleaned)])
    out = service.explain(*cleaned)
    return JSONResponse({**out, "meta": response_meta(weather=False)})
