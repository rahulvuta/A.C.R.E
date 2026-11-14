"""The one call to Claude (card B3). Tests replace :func:`set_caller` with a recorded response.

Credentials come from the environment (``ANTHROPIC_API_KEY`` or ``ANTHROPIC_AUTH_TOKEN``); without
one, research is ``unavailable`` / ``research_not_configured`` and nothing is sent.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any

MAX_CONTINUATIONS = 4  # server tools can pause a long turn; resume at most this often
TIMEOUT_S = 600.0


class ResearchError(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()
                or os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip())  # fmt: skip


def _live(params: dict[str, Any]) -> dict[str, Any]:
    """Run the request with the Anthropic SDK and return the parsed JSON answer."""
    try:
        import anthropic
    except ImportError as exc:
        raise ResearchError("research_sdk_missing", "the anthropic package is not installed") from exc
    client = anthropic.Anthropic(timeout=TIMEOUT_S, max_retries=2)
    messages = list(params["messages"])
    kwargs = {k: v for k, v in params.items() if k != "messages"}
    try:
        for _ in range(MAX_CONTINUATIONS + 1):
            with client.beta.messages.stream(messages=messages, **kwargs) as stream:
                msg = stream.get_final_message()
            if msg.stop_reason == "pause_turn":  # resume the paused server-tool turn
                messages = [*messages, {"role": "assistant", "content": msg.content}]
                continue
            break
        else:
            raise ResearchError("research_too_long", "the research turn did not finish")
    except anthropic.RateLimitError as exc:
        raise ResearchError("research_rate_limited") from exc
    except anthropic.APIStatusError as exc:
        raise ResearchError("research_api_error", f"HTTP {exc.status_code}") from exc
    except anthropic.APIConnectionError as exc:
        raise ResearchError("research_unreachable") from exc
    if msg.stop_reason == "refusal":
        raise ResearchError("research_refused")
    if msg.stop_reason == "max_tokens":
        raise ResearchError("research_truncated")
    text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
    return parse_answer(text)


def parse_answer(text: str) -> dict[str, Any]:
    try:
        doc = json.loads(text)
    except ValueError as exc:
        raise ResearchError("research_bad_output", "the answer was not JSON") from exc
    if not isinstance(doc, dict):
        raise ResearchError("research_bad_output", "the answer was not an object")
    return doc


_CALLER: list[Callable[[dict[str, Any]], dict[str, Any]]] = []


def set_caller(fn: Callable[[dict[str, Any]], dict[str, Any]] | None) -> None:
    """Replace the live call (tests: a recorded answer). ``None`` restores the SDK call."""
    _CALLER.clear()
    if fn is not None:
        _CALLER.append(fn)


def call(params: dict[str, Any]) -> dict[str, Any]:
    if _CALLER:
        return _CALLER[0](params)
    if not configured():
        raise ResearchError("research_not_configured")
    return _live(params)
