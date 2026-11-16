"""The three result sentences, reworded as one short explanation by a model (card 26).

The page sends the figures it already shows, as the exact strings on screen (``"KES 331,552"``,
``"725 mm"``, ``"2"``). The model is asked to explain them in plain words. Its answer is then
checked in code and thrown away unless it passes:

* every number in the answer is one of the numbers that was sent, written the same way;
* no number is spelled out or implied ("half", "twice", "one in five");
* no advice ("should", "recommend") and no promise about a single year;
* it is short.

A rejected answer is asked for once more; after that the page keeps its own template sentences,
which are always shown. The answer is labelled as written by AI (``origin: ai_suggested``).

What reaches the model: number strings that match a strict pattern, crop ids, and on/off facts.
No field, farm or place name, no coordinate, and no free text from the page (so the page cannot
be used to pass other instructions to the model). Answers are saved in
``$ACRE_CACHE_DIR/explanations.sqlite`` and written once per distinct set of figures.
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

MODEL_ENV = "ACRE_EXPLAIN_MODEL"
DEFAULT_MODEL = "google/gemini-2.5-flash"
DAILY_ENV = "ACRE_EXPLAIN_DAILY"
DEFAULT_DAILY = 500  # new explanations a day, across all clients
PROMPT_VERSION = "x2"
MAX_CHARS = 700
MAX_WORDS = 110

# What each figure means, said to the model. The page may send any subset of these.
FACTS: dict[str, str] = {
    "years": "how many years the plan was run through",
    "dry_years": "in a typical run, the number of those years in which the weeks before planting "
                 "were too dry",
    "dry_low": "the low end of that number across the runs",
    "dry_high": "the high end of that number across the runs",
    "rain_bare": "rain that falls in a typical year while the ground is bare",
    "heavy_days": "days in a typical year when heavy rain falls on bare ground",
    "money_year": "money left in a typical year for the whole field, after the costs in the plan",
    "money_total": "the same money over all the years",
    "money_low": "the low end of the money over all the years, across the runs",
    "money_high": "the high end of the money over all the years, across the runs",
}  # fmt: skip
FLAGS: dict[str, str] = {
    "money_uses_loss_estimate": "the money includes the farmer's own estimate of what a bad year "
                                "costs",
    "money_flat": "the money is the same in every run because the farmer has not said what a bad "
                  "year costs",
    "no_money": "there is no money result because a price, a yield or a cost is missing",
    "nothing_sold": "nothing is sold from this field in the plan (for example grazed pasture), "
                    "so there is no money result and none is missing",
    "two_crops_a_year": "two crops are harvested every year",
    "ground_covered_all_year": "the crop stays in the ground all year, so there is no bare ground "
                               "and no planting time; the weather was not used for its yield",
    "crops_grown_together": "another crop is grown in the same field together with the main crop "
                            "and is counted in the money",
}  # fmt: skip
# A figure as the page shows it: an optional currency code or symbol, a number, an optional unit.
FACT_VALUE = re.compile(r"^-?(?:[A-Z]{3}[ \u00a0]?|[$€£₹₦₱₩¥][ \u00a0]?)?-?\d(?:[\d,. \u00a0\u202f]{0,18}\d)?"
                        r"(?:[ \u00a0]?(?:mm|in|%|°C|°F))?$")  # fmt: skip
CROP_ID = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
NUMBER = re.compile(r"\d+(?:[.,\u00a0\u202f]\d+)*")
NUMBER_WORDS = re.compile(
    r"\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
    r"fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|"
    r"ninety|hundred|thousand|million|billion|half|halves|third|thirds|quarter|quarters|fifth|"
    r"tenth|twice|thrice|double|doubles|doubled|triple|tripled|dozen|couple|percent|per cent)\b",
    re.IGNORECASE)  # fmt: skip
ADVICE = re.compile(r"\b(should|shouldn't|recommend\w*|advis\w*|must|ought|need to|needs to|"
                    r"consider\w*|suggest\w*|try to|make sure|be sure|will be|is going to|"
                    r"guarantee\w*|expect\w* to)\b", re.IGNORECASE)  # fmt: skip

SYSTEM = (
    "You explain the result of a 10-year farm plan check to a working farmer. You are given facts "
    "as JSON: each fact has its meaning and its value. Write one short paragraph of 2 to 4 "
    "sentences, at most 70 words, the way you would say it to a neighbour over a fence: everyday "
    "words, short sentences, no report language. Say first what the weather picture is at "
    "planting time and for bare ground, then what the plan leaves in money in a typical year and "
    "how far that moved between the lowest and highest runs. Use each figure at most once; leave "
    "out a figure that adds nothing. Rules, all of them strict: use only the facts given; copy "
    "every number exactly as it is written in the facts, with its unit or currency, and use no "
    "other number at all, neither in digits nor in words (never 'half', 'twice', 'a couple', "
    "'one in five', 'percent'); do not give advice and do not say what the farmer should do; do "
    "not say what will happen in any single year; do not call anything good, bad, risky or "
    "safe; do not mention anything that is not in the facts; no lists, no headings. The facts "
    "come from past weather replayed in new orders, so use the past tense and say 'in a typical "
    "run', never 'will'. Reply with JSON only: {\"text\": \"...\"}"
)

_lock = threading.Lock()
_spent: dict[str, int] = {}


def model() -> str:
    return os.environ.get(MODEL_ENV, "").strip() or DEFAULT_MODEL


def clean_request(facts: Any, flags: Any, crops: Any) -> tuple[dict[str, str], list[str], list[str]] | str:
    """The validated request, or a sentence saying what is wrong with it."""
    if not isinstance(facts, dict) or not facts:
        return "facts must be an object with at least one figure"
    out: dict[str, str] = {}
    for key, value in facts.items():
        if key not in FACTS:
            return f"facts.{key} is not a figure this call knows"
        if not isinstance(value, str) or len(value) > 28 or not FACT_VALUE.match(value.strip()):
            return f"facts.{key} must be a number as shown on the page, such as '725 mm'"
        out[key] = value.strip()
    on = [] if flags is None else flags
    if not isinstance(on, list) or any(f not in FLAGS for f in on):
        return f"flags must be a list from {sorted(FLAGS)}"
    names = [] if crops is None else crops
    if (not isinstance(names, list) or len(names) > 8
            or any(not isinstance(c, str) or not CROP_ID.match(c) for c in names)):  # fmt: skip
        return "crops must be a list of at most 8 crop ids"
    return out, sorted(set(on)), list(dict.fromkeys(names))


def numbers_in(text: str) -> list[str]:
    return NUMBER.findall(text)


def check(text: Any, facts: dict[str, str]) -> str | None:
    """Why an answer is not usable, or None when it is."""
    if not isinstance(text, str) or not text.strip():
        return "it was empty"
    t = text.strip()
    if len(t) > MAX_CHARS or len(t.split()) > MAX_WORDS:
        return "it was too long"
    if "\n" in t or t.lstrip().startswith(("-", "*", "#")):
        return "it was a list or had headings"
    allowed = {n for v in facts.values() for n in numbers_in(v)}
    extra = [n for n in numbers_in(t) if n not in allowed]
    if extra:
        return f"it used a number that is not in the facts ({extra[0]})"
    word = NUMBER_WORDS.search(t)
    if word:
        return f"it spelled out or implied a number ('{word.group(0)}')"
    advice = ADVICE.search(t)
    if advice:
        return f"it gave advice or a prediction ('{advice.group(0)}')"
    return None


def _db() -> Path:
    return cache_root() / "explanations.sqlite"


def _connect() -> sqlite3.Connection:
    path = _db()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.execute("CREATE TABLE IF NOT EXISTS explanations (key TEXT PRIMARY KEY, text TEXT NOT NULL, "
                "model TEXT NOT NULL, created_at REAL NOT NULL)")  # fmt: skip
    return con


def _key(facts: dict[str, str], flags: list[str], crops: list[str]) -> str:
    blob = json.dumps({"v": PROMPT_VERSION, "model": model(), "facts": facts, "flags": flags,
                       "crops": crops}, sort_keys=True, ensure_ascii=False)  # fmt: skip
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _budget_left() -> bool:
    try:
        cap = int(os.environ.get(DAILY_ENV, "") or DEFAULT_DAILY)
    except ValueError:
        cap = DEFAULT_DAILY
    day = time.strftime("%Y-%m-%d", time.gmtime())
    with _lock:
        for old in [d for d in _spent if d != day]:
            del _spent[old]
        if _spent.get(day, 0) >= cap:
            return False
        _spent[day] = _spent.get(day, 0) + 1
        return True


def _ask(facts: dict[str, str], flags: list[str], crops: list[str], previous: str | None) -> Any:
    payload = {"facts": [{"meaning": FACTS[k], "value": v} for k, v in facts.items()],
               "also_true": [FLAGS[f] for f in flags],
               "crops_in_the_plan": [c.replace("_", " ") for c in crops]}  # fmt: skip
    user = json.dumps(payload, ensure_ascii=False)
    if previous:
        user += f"\n\nYour last answer was not usable because {previous}. Write it again."
    reply = client.call({"model": model(), "temperature": 0.2, "max_tokens": 400,
                         "messages": [{"role": "system", "content": SYSTEM},
                                      {"role": "user", "content": user}]}, timeout_s=45.0)  # fmt: skip
    return client.parse_answer(reply.text).get("text")


def explain(facts: dict[str, str], flags: list[str], crops: list[str]) -> dict[str, Any]:
    """A checked plain-words explanation of the figures, or ``unavailable`` with the reason."""
    base = {"origin": "ai_suggested", "model": model(), "text": None,
            "numbers_allowed": sorted({n for v in facts.values() for n in numbers_in(v)})}  # fmt: skip
    key = _key(facts, flags, crops)
    with _lock, _connect() as con:
        row = con.execute("SELECT text FROM explanations WHERE key = ?", (key,)).fetchone()
    # A saved answer is checked again: the rules may have been tightened since it was written.
    if row and check(row[0], facts) is None:
        return {**base, "status": "complete", "text": row[0], "code": None, "reason_text": None}

    def unavailable(code: str, text: str) -> dict[str, Any]:
        return {**base, "status": "unavailable", "code": code, "reason_text": text}

    if not client._CALLER and not client.configured():
        return unavailable("explain_not_configured", "Plain-words explanations are not set up on "
                           "this service.")  # fmt: skip
    if not _budget_left():
        return unavailable("explain_daily_limit", "Today's limit of explanations has been reached.")
    why: str | None = None
    for _attempt in range(2):
        try:
            text = _ask(facts, flags, crops, why)
        except client.ResearchError as exc:
            return unavailable(exc.code, "The explanation could not be written just now.")
        why = check(text, facts)
        if why is None:
            clean = " ".join(str(text).split())
            with _lock, _connect() as con:
                con.execute("INSERT OR REPLACE INTO explanations VALUES (?, ?, ?, ?)",
                            (key, clean, model(), time.time()))  # fmt: skip
            return {**base, "status": "complete", "text": clean, "code": None, "reason_text": None}
    return unavailable("explanation_rejected", f"The explanation was not used because {why}.")
