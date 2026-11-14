"""The one model call of AI research, through OpenRouter's chat completions API (plain httpx).

Credentials come from ``OPENROUTER_API_KEY``; without it research is ``unavailable`` /
``research_not_configured`` and nothing is sent. The model is ``FIELDSHIFT_RESEARCH_MODEL``
(any OpenRouter slug). Tests either replace the whole call with :func:`set_caller` or route the
HTTP request through :func:`set_transport` (an ``httpx.MockTransport``).

The request carries only the prompt built from a region query (see ``prompt.py``) and generic
headers; no farm, location or person data.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

URL = "https://openrouter.ai/api/v1/chat/completions"
KEY_ENV = "OPENROUTER_API_KEY"
REFERER = "http://localhost"  # generic app attribution for OpenRouter
TITLE = "A.C.R.E"
TIMEOUT_S = 600.0


class ResearchError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


@dataclass
class Reply:
    """The model's answer text and the raw provider response (stored with the cached profile)."""

    text: str
    raw: dict[str, Any] | None = None


def configured() -> bool:
    return bool(os.environ.get(KEY_ENV, "").strip())


_TRANSPORT: list[httpx.BaseTransport] = []


def set_transport(t: httpx.BaseTransport | None) -> None:
    """Route the live request through ``t`` (tests: ``httpx.MockTransport``). ``None`` resets."""
    _TRANSPORT.clear()
    if t is not None:
        _TRANSPORT.append(t)


def _live(body: dict[str, Any]) -> Reply:
    headers = {"Authorization": f"Bearer {os.environ.get(KEY_ENV, '').strip()}",
               "HTTP-Referer": REFERER, "X-Title": TITLE,
               "Content-Type": "application/json"}  # fmt: skip
    kw: dict[str, Any] = {"timeout": httpx.Timeout(TIMEOUT_S, connect=20.0)}
    if _TRANSPORT:
        kw["transport"] = _TRANSPORT[0]
    try:
        with httpx.Client(**kw) as c:
            r = c.post(URL, headers=headers, json=body)
    except httpx.TimeoutException as exc:
        raise ResearchError("research_timeout") from exc
    except httpx.HTTPError as exc:
        raise ResearchError("provider_error", "the research service could not be reached") from exc
    if r.status_code == 429:
        raise ResearchError("rate_limited")
    if r.status_code in (408, 504):
        raise ResearchError("research_timeout", f"HTTP {r.status_code}")
    if r.status_code >= 400:
        raise ResearchError("provider_error", f"HTTP {r.status_code}")
    try:
        raw = r.json()
        choice = raw["choices"][0]
        text = choice["message"].get("content") or ""
    except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
        raise ResearchError("provider_error", "unexpected response shape") from exc
    if isinstance(raw.get("error"), dict):
        raise ResearchError("provider_error", str(raw["error"].get("code") or "error"))
    if choice.get("finish_reason") == "length":
        raise ResearchError("research_truncated")
    if isinstance(text, list):  # some providers return content parts
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    return Reply(str(text), raw)


def parse_answer(text: str) -> dict[str, Any]:
    t = (text or "").strip()
    if t.startswith("```"):  # tolerate a fenced answer
        t = t.strip("`").removeprefix("json").strip()
    try:
        doc = json.loads(t)
    except ValueError as exc:
        raise ResearchError("research_bad_output", "the answer was not JSON") from exc
    if not isinstance(doc, dict):
        raise ResearchError("research_bad_output", "the answer was not an object")
    return doc


_CALLER: list[Callable[[dict[str, Any]], Any]] = []


def set_caller(fn: Callable[[dict[str, Any]], Any] | None) -> None:
    """Replace the live call (tests: a recorded answer, as a dict or text). ``None`` restores it."""
    _CALLER.clear()
    if fn is not None:
        _CALLER.append(fn)


def call(body: dict[str, Any]) -> Reply:
    if _CALLER:
        out = _CALLER[0](body)
        if isinstance(out, Reply):
            return out
        return Reply(out if isinstance(out, str) else json.dumps(out), None)
    if not configured():
        raise ResearchError("research_not_configured")
    return _live(body)
