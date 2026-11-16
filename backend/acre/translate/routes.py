"""``POST /v1/translate``: on-screen text into the grower's language (card 18).

Body: ``{"language": "Swahili", "texts": ["Plant maize", "About {0} mm of rain a year"]}``.
Answer: ``{"status", "language", "translations": [str | null, ...], "origin": "ai_suggested",
"model", "code", "reason_text", "note", "meta"}``; a ``null`` means "keep the English".
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from acre.report.http import invalid, issue, read_object
from acre.report.meta import response_meta
from acre.translate import service

router = APIRouter(prefix="/v1", tags=["translate"])


@router.post("/translate")
async def translate(request: Request) -> JSONResponse:
    body, bad = await read_object(request)
    if bad is not None or body is None:
        return bad  # type: ignore[return-value]
    language, texts = body.get("language"), body.get("texts")
    problems: list[dict[str, str]] = []
    if not isinstance(language, str) or not service.LANGUAGE.match(language.strip()):
        problems.append(issue("language", "bad_language", "language must be the name of a "
                              "language, for example 'Swahili'"))  # fmt: skip
    if not isinstance(texts, list) or not texts or len(texts) > service.MAX_TEXTS:
        problems.append(issue("texts", "bad_texts", f"texts must be a list of 1 to "
                              f"{service.MAX_TEXTS} strings"))  # fmt: skip
    elif any(not isinstance(t, str) or not t.strip() or len(t) > service.MAX_TEXT_CHARS
             for t in texts):  # fmt: skip
        problems.append(issue("texts", "bad_text", f"each text must be a non-empty string of at "
                              f"most {service.MAX_TEXT_CHARS} characters"))  # fmt: skip
    elif sum(len(t) for t in texts) > service.MAX_TOTAL_CHARS:
        problems.append(issue("texts", "too_much_text", f"at most {service.MAX_TOTAL_CHARS} "
                              "characters per request"))  # fmt: skip
    if problems:
        return invalid(problems)
    out: dict[str, Any] = service.translate(language, texts)  # type: ignore[arg-type]
    return JSONResponse({**out, "meta": response_meta(weather=False)})
