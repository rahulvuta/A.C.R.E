"""Translate short pieces of on-screen text into any language, once each.

English is the app's one source text. The web page collects what is on screen, takes every
number out (``"About {0} mm of rain a year"``) and asks here for the sentences it has not seen
in the grower's language. Each sentence is translated by the model behind ``OPENROUTER_API_KEY``
(``ACRE_TRANSLATE_MODEL``), checked, and saved in ``$ACRE_CACHE_DIR/translations.sqlite`` so it is
never paid for twice.

Rules kept here:

* A translation must carry exactly the placeholders of its source (``{0}``, ``{1}``...), so no
  number can be changed, dropped or invented. A translation that fails this is not returned and
  the page keeps the English.
* Only text is sent to the model: no place, field, farm or person data. The page leaves out
  anything the grower typed.
* Output is machine translation and is labelled as such by the page; it is never a source for a
  number or a farming fact.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from acre.geo.config import cache_root
from acre.research import client

MODEL_ENV = "ACRE_TRANSLATE_MODEL"
# Chosen by trying the same app sentences in Swahili, Hindi and Arabic: the clearest farming
# words and the quickest answer of the models tried. Change it with ACRE_TRANSLATE_MODEL.
DEFAULT_MODEL = "google/gemini-2.5-flash"
DAILY_ENV = "ACRE_TRANSLATE_DAILY_CHARS"
DEFAULT_DAILY_CHARS = 400_000  # new text sent to the model per day, across all clients

MAX_TEXTS = 60
MAX_TEXT_CHARS = 1600
MAX_TOTAL_CHARS = 12_000
PLACEHOLDER = re.compile(r"\{\d+\}")
LANGUAGE = re.compile(r"^[^\W\d_](?:[^\W\d_]|[ '()\-]){1,48}$", re.UNICODE)

GLOSSARY = (
    "Farming words: 'bare ground' or 'bare soil' means soil with nothing growing on it; a "
    "'cover crop' is a crop grown to protect the soil, not to sell; 'yield' is how much is "
    "harvested from an area; 'rotation' is the order crops follow each other on one field; "
    "'planting' and 'harvest' are the farm jobs; 'dry planting season' means the weeks before "
    "planting had too little rain; a 'field' is always a piece of farmland, never a box on a "
    "form; to 'simulate' or 'replay' a plan means to try it out against past weather; a 'bag' "
    "is a sack of harvested grain; 'weather losses' are crops lost to bad weather."
)

SYSTEM = (
    "You translate the on-screen text of a farm planning app for working farmers. Translate "
    "from English into the language named by the user. Use plain, everyday words a farmer "
    "would use, not office or scientific language. Keep short labels and button text short. "
    + GLOSSARY
    + " A placeholder such as {0} or {1} stands for a number, an amount of money or a "
    "measurement with its unit (for example 341 mm or KES 51,000) that the app puts back "
    "itself; write the sentence so it reads naturally around it. Rules: keep every placeholder "
    "exactly as it is and exactly once each; never add, remove or change a number; keep 'A.C.R.E', 'NASA', units (mm, in, ha, "
    "ac, kg, t, °C, °F), currency codes (USD, KES, INR) and web addresses unchanged; keep "
    "punctuation such as a trailing colon or arrow; do not add notes or explanations. Reply "
    'with JSON only: {"translations": ["...", "..."]} with one item per input string, in the '
    "same order."
)

_lock = threading.Lock()
_spent: dict[str, int] = {}


def model() -> str:
    return os.environ.get(MODEL_ENV, "").strip() or DEFAULT_MODEL


def _db_path() -> Path:
    return cache_root() / "translations.sqlite"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.execute(
        "CREATE TABLE IF NOT EXISTS translations (lang TEXT NOT NULL, src_hash TEXT NOT NULL, "
        "src TEXT NOT NULL, out TEXT NOT NULL, model TEXT NOT NULL, created_at REAL NOT NULL, "
        "PRIMARY KEY (lang, src_hash))"
    )
    return con


def _key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def language_key(name: str) -> str:
    return " ".join(name.strip().lower().split())


def placeholders(text: str) -> list[str]:
    return sorted(PLACEHOLDER.findall(text))


def acceptable(source: str, translated: Any) -> bool:
    """A usable translation: text, and exactly the source's placeholders (so no number moved)."""
    return (isinstance(translated, str) and bool(translated.strip())
            and len(translated) <= max(200, len(source) * 6)
            and placeholders(translated) == placeholders(source))  # fmt: skip


def _cached(lang: str, texts: list[str]) -> dict[str, str]:
    if not texts:
        return {}
    with _lock, _connect() as con:
        rows = con.execute(
            f"SELECT src, out FROM translations WHERE lang = ? AND src_hash IN "
            f"({','.join('?' * len(texts))})", [lang, *[_key(t) for t in texts]]).fetchall()  # fmt: skip
    return {src: out for src, out in rows}


def _save(lang: str, pairs: dict[str, str]) -> None:
    if not pairs:
        return
    now = time.time()
    with _lock, _connect() as con:
        con.executemany(
            "INSERT OR REPLACE INTO translations VALUES (?, ?, ?, ?, ?, ?)",
            [(lang, _key(s), s, o, model(), now) for s, o in pairs.items()])  # fmt: skip


def _budget_left(chars: int) -> bool:
    """A daily ceiling on new text sent to the model, so the key cannot be run down."""
    try:
        cap = int(os.environ.get(DAILY_ENV, "") or DEFAULT_DAILY_CHARS)
    except ValueError:
        cap = DEFAULT_DAILY_CHARS
    day = time.strftime("%Y-%m-%d", time.gmtime())
    with _lock:
        for old in [d for d in _spent if d != day]:
            del _spent[old]
        if _spent.get(day, 0) + chars > cap:
            return False
        _spent[day] = _spent.get(day, 0) + chars
        return True


def _ask(language: str, texts: list[str], depth: int = 0) -> list[Any]:
    """One answer per text, ``None`` where the model gave nothing usable.

    A reply that is not the JSON asked for, or holds the wrong number of items, is not thrown
    away whole: the batch is asked again in two halves, so one awkward sentence cannot keep a
    whole screen in English.
    """
    body = {
        "model": model(),
        "temperature": 0,
        "max_tokens": 8000,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps({"language": language, "strings": texts},
                                                   ensure_ascii=False)},  # fmt: skip
        ],
    }
    try:
        reply = client.call(body, timeout_s=90.0)
        out = client.parse_answer(reply.text).get("translations")
        if isinstance(out, dict):
            out = [out.get(str(i)) for i in range(len(texts))]
        if not isinstance(out, list) or len(out) != len(texts):
            raise client.ResearchError("research_bad_output", "wrong number of translations")
        return out
    except client.ResearchError as exc:
        if exc.code != "research_bad_output":
            raise
        if len(texts) < 2 or depth >= 4:
            return [None] * len(texts)
        mid = len(texts) // 2
        return _ask(language, texts[:mid], depth + 1) + _ask(language, texts[mid:], depth + 1)


def translate(language: str, texts: list[str]) -> dict[str, Any]:
    """Translations for ``texts`` in order (``None`` where there is none), from the saved store
    first and the model for the rest."""
    lang = language_key(language)
    distinct = list(dict.fromkeys(texts))
    known = _cached(lang, distinct)
    missing = [t for t in distinct if t not in known]
    status, code, reason = "complete", None, None
    if missing:
        if not client._CALLER and not client.configured():
            status, code = "unavailable", "translate_not_configured"
            reason = "Translation is not set up on this service yet."
        elif not _budget_left(sum(len(t) for t in missing)):
            status, code = "unavailable", "translate_daily_limit"
            reason = "Today's translation limit has been reached. Try again tomorrow."
        else:
            try:
                answers = _ask(language.strip(), missing)
                fresh = {s: o.strip() for s, o in zip(missing, answers, strict=True)
                         if acceptable(s, o)}  # fmt: skip
                _save(lang, fresh)
                known.update(fresh)
                if len(fresh) < len(missing):
                    status, code = "partial", "translation_rejected"
                    reason = "Some text could not be translated safely and stays in English."
            except client.ResearchError as exc:
                status, code = "unavailable", exc.code
                reason = "The translation service could not be reached. Try again in a moment."
    return {
        "status": status,
        "language": language.strip(),
        "translations": [known.get(t) for t in texts],
        "origin": "ai_suggested",
        "model": model(),
        "code": code,
        "reason_text": reason,
        "note": "Machine translated. Numbers are never translated: they are put back exactly.",
    }
