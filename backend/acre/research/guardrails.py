"""Deterministic guardrails on an AI research answer. The AI only proposes; this code decides.

The pipeline order is: AI → schema validation (:func:`schema_errors`) → guardrails (:func:`apply`)
→ quote verification (``verify.check_answer``) → cache. Every drop, downgrade or flag is logged
with a reason.

* Vocabularies: crop ids, ``condition_key``, units, operators and rule types come only from the
  catalog v3 vocabularies (crop ids, ``validate``, and the condition keys of the verified catalog
  and the rule engine). A row that uses anything else is dropped.
* Sources: a missing ``source_url`` drops the item. A domain off the allowlist caps the item at
  ``ai_suggested`` (it can never become ``source_checked``).
* Numbers: values must lie in a plausible range for their unit; every MM-DD must be a real date.
* Calendars: an AI planting or harvest window must overlap the SAGE window for that crop and cell,
  widened by 30 days on each side, or it is flagged ``manual_check`` ("disagrees with gridded crop
  calendar").
* Quotes are capped at 30 words; rows are capped at 60 and sorted by
  (section, crop_id, rule_type, source_url).
* Drift stop: if more than half of the items are dropped, the profile is ``partial`` with the gap
  "AI output failed guardrails".
"""

from __future__ import annotations

import csv
import hashlib
import os
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from acre.catalogs import crop_ids, validate

GUARDRAIL_VERSION = "g1"
DOMAINS_ENV = "ACRE_RESEARCH_DOMAINS"  # comma-separated extra allowed domains
MAX_ROWS = 60
MAX_QUOTE_WORDS = 30
SAGE_SLACK_DAYS = 30
DRIFT_LIMIT = 0.5
DRIFT_GAP = "AI output failed guardrails"
SAGE_REASON = "disagrees with gridded crop calendar"

#: Plausible bounds per unit (inclusive). Temperatures are °F in the catalog: −20..50 °C.
UNIT_RANGES: dict[str, tuple[float, float]] = {
    "degF": (-4.0, 122.0),
    "in": (0.0, 200.0),
    "GDD_F": (0.0, 6000.0),
    "days": (0.0, 400.0),
    "weeks": (0.0, 57.0),
    "hours": (0.0, 24.0),
    "pH": (3.0, 10.0),
    "lb_N_per_acre": (0.0, 400.0),
    "bu_per_acre": (0.0, 400.0),
    "in_per_day": (0.0, 2.0),
    "in_per_ft": (0.0, 5.0),
    "maturity_group": (-1.0, 10.0),
    "seeds/ft2": (0.0, 200.0),
    "seeds/acre": (0.0, 1_000_000.0),
}

#: Domain suffixes always allowed (government, education, research bodies).
ALLOWED_SUFFIXES = (".gov", ".edu", ".mil")
_ALLOWED_PATTERNS = (
    re.compile(r"(^|\.)gov\.[a-z]{2}$"),  # gov.ar, gov.in ...
    re.compile(r"(^|\.)gob\.[a-z]{2}$"),  # gob.ar, gob.mx ...
    re.compile(r"(^|\.)gouv\.fr$"),
    re.compile(r"(^|\.)ac\.[a-z]{2}$"),  # ac.in, ac.uk ...
    re.compile(r"(^|\.)edu\.[a-z]{2}$"),  # edu.ar, edu.au ...
    re.compile(r"(^|\.)(fao|cgiar|inrae|cirad|icar|irri|cimmyt|icrisat)\.org$"),
    re.compile(r"(^|\.)inta\.gob\.ar$"),
    re.compile(r"(^|\.)icar\.(gov|org)\.in$"),
    re.compile(r"(^|\.)(inrae|cirad|arvalis|terresinovia)\.fr$"),
    re.compile(r"(^|\.)extension\.[a-z.]+$"),
    re.compile(r"(^|\.)(uni|univ|universidad|universite|universidade)[a-z-]*\.[a-z.]+$"),
)
_MMDD = re.compile(r"^(\d{2})-(\d{2})$")
_SECTIONS = ("rows", "crops", "cover_crops", "rotations", "double_crops")


@lru_cache(maxsize=1)
def condition_keys() -> frozenset[str]:
    """Condition keys the verified catalog uses plus the ones the rule engine evaluates."""
    from acre.metrics import rules

    keys = set(rules.NUMERIC_INPUTS) | {k for k in rules.SEQUENCE_ONLY_CONDITIONS if k}
    root = Path(__file__).resolve().parents[2] / "data" / "catalogs"
    for v in ("v1", "v2"):
        p = root / v / "crop_rules.csv"
        if p.exists():
            with p.open(encoding="utf-8") as f:
                keys |= {r["condition_key"].strip() for r in csv.DictReader(f)
                         if (r.get("condition_key") or "").strip()}  # fmt: skip
    return frozenset(keys)


def vocab_version() -> str:
    """A short hash of every vocabulary the guardrails enforce (part of the cache key)."""
    parts = [sorted(c.crop_id for c in crop_ids.CROPS), sorted(condition_keys()),
             sorted(validate.UNITS), sorted(validate.OPERATORS), sorted(validate.RULE_TYPES),
             sorted(UNIT_RANGES.items()), GUARDRAIL_VERSION]  # fmt: skip
    return hashlib.sha256(repr(parts).encode()).hexdigest()[:12]


def extra_domains() -> tuple[str, ...]:
    raw = os.environ.get(DOMAINS_ENV, "")
    return tuple(d.strip().lower().lstrip(".") for d in raw.split(",") if d.strip())


def domain_allowed(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower().rstrip(".")
    if not host:
        return False
    if host.endswith(ALLOWED_SUFFIXES) or any(p.search(host) for p in _ALLOWED_PATTERNS):
        return True
    return any(host == d or host.endswith("." + d) for d in extra_domains())


def valid_mmdd(v: Any) -> bool:
    m = _MMDD.match(v) if isinstance(v, str) else None
    if not m:
        return False
    try:
        date(2000, int(m[1]), int(m[2]))  # a leap year, so 02-29 is a real date
    except ValueError:
        return False
    return True


def _doy(mmdd: str) -> int:
    """Day of a 365-day year (02-29 counts as 02-28)."""
    m, d = int(mmdd[:2]), int(mmdd[3:])
    if (m, d) == (2, 29):
        d = 28
    return (date(2001, m, d) - date(2001, 1, 1)).days


def _arc(start: str, end: str, slack: int = 0) -> set[int]:
    a, b = _doy(start), _doy(end)
    length = (b - a) % 365
    return {(a - slack + i) % 365 for i in range(length + 1 + 2 * slack)}


def overlaps_sage(ai: dict[str, Any] | None, sage: dict[str, Any] | None) -> bool | None:
    """Does the AI window touch the SAGE window ± 30 days? ``None`` when either is unknown."""
    if not (isinstance(ai, dict) and isinstance(sage, dict)):
        return None
    if not all(valid_mmdd(w.get(k)) for w in (ai, sage) for k in ("start", "end")):
        return None
    return bool(_arc(ai["start"], ai["end"]) & _arc(sage["start"], sage["end"], SAGE_SLACK_DAYS))


@dataclass
class GuardrailLog:
    total: int = 0
    dropped: list[dict[str, str]] = field(default_factory=list)
    downgraded: list[dict[str, str]] = field(default_factory=list)
    flagged: list[dict[str, str]] = field(default_factory=list)

    @property
    def drift(self) -> bool:
        return self.total > 0 and len(self.dropped) / self.total > DRIFT_LIMIT

    def as_dict(self) -> dict[str, Any]:
        return {"guardrail_version": GUARDRAIL_VERSION, "items_in": self.total,
                "dropped": self.dropped, "downgraded": self.downgraded, "flagged": self.flagged,
                "drift_stop": self.drift}  # fmt: skip


def _label(section: str, item: dict[str, Any]) -> str:
    ident = item.get("rule_id") or item.get("crop_id") or item.get("winter_crop") or item.get(
        "label") or "?"
    return f"{section}:{ident}"


def _sort_key(section: str, item: dict[str, Any]) -> tuple[str, str, str, str, str]:
    cid = str(item.get("crop_id") or item.get("winter_crop") or item.get("label") or "")
    return (section, cid, str(item.get("rule_type") or ""), str(item.get("source_url") or ""),
            str(item.get("rule_id") or ""))  # fmt: skip


def _common(section: str, item: dict[str, Any], log: GuardrailLog) -> str | None:
    """Checks every item gets; returns a drop reason or ``None``."""
    url = item.get("source_url")
    if not isinstance(url, str) or not url.strip():
        return "no source_url"
    if not url.startswith(("https://", "http://")):
        return "source_url is not a web address"
    quote = item.get("evidence_quote")
    if isinstance(quote, str) and len(quote.split()) > MAX_QUOTE_WORDS:
        return f"evidence_quote longer than {MAX_QUOTE_WORDS} words"
    if not domain_allowed(url):
        item["_domain_ok"] = False
        log.downgraded.append({"item": _label(section, item), "reason": "source domain not on "
                               f"the allowlist ({urlparse(url).hostname}); ai_suggested at best"})  # fmt: skip
    return None


def _row_problem(r: dict[str, Any]) -> str | None:
    if crop_ids.canonical(r.get("crop_id")) is None:
        return f"crop_id '{r.get('crop_id')}' is not in the vocabulary"
    for f in ("previous_crop_id", "next_crop_id"):
        if r.get(f) and crop_ids.canonical(r[f]) is None:
            return f"{f} '{r[f]}' is not in the vocabulary"
    if r.get("rule_type") not in validate.RULE_TYPES:
        return f"rule_type '{r.get('rule_type')}' is not in the vocabulary"
    ck = r.get("condition_key")
    if ck is not None and ck not in condition_keys():
        return f"condition_key '{ck}' is not in the vocabulary"
    unit = r.get("unit")
    if unit is not None and unit not in validate.UNITS:
        return f"unit '{unit}' is not in the vocabulary"
    op = r.get("operator")
    if op is not None and op not in validate.OPERATORS:
        return f"operator '{op}' is not in the vocabulary"
    for f in ("window_start_mm_dd", "window_end_mm_dd"):
        if r.get(f) is not None and not valid_mmdd(r[f]):
            return f"{f} '{r[f]}' is not a valid MM-DD date"
    nums = [r.get(f) for f in ("value_min", "value_max")]
    if any(isinstance(v, int | float) and not isinstance(v, bool) for v in nums):
        if unit is None:
            return "a number without a unit"
        lo, hi = UNIT_RANGES.get(unit, (float("-inf"), float("inf")))
        for f, v in zip(("value_min", "value_max"), nums, strict=True):
            if isinstance(v, int | float) and not lo <= v <= hi:
                return f"{f}={v:g} {unit} is outside the plausible range {lo:g}..{hi:g}"
        if all(isinstance(v, int | float) for v in nums) and nums[0] > nums[1]:
            return "value_min is above value_max"
    return None


def _windows_problem(item: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for k in keys:
        w = item.get(k)
        if w is None:
            continue
        if not isinstance(w, dict) or not all(valid_mmdd(w.get(x)) for x in ("start", "end")):
            return f"{k} window is not a pair of valid MM-DD dates"
    return None


def _flag(section: str, item: dict[str, Any], log: GuardrailLog, what: str) -> None:
    item["review"] = "manual_check"
    note = f"{what} {SAGE_REASON} (SAGE ± {SAGE_SLACK_DAYS} days); check with an adviser"
    item["limitations"] = "; ".join(x for x in (item.get("limitations"), note) if x)
    log.flagged.append({"item": _label(section, item), "reason": SAGE_REASON, "window": what})


def apply(answer: dict[str, Any], sage: dict[str, dict[str, Any]] | None = None
          ) -> tuple[dict[str, Any], GuardrailLog]:  # fmt: skip
    """Filter a schema-valid answer. ``sage`` is crop_id -> {plant, harvest} for the cell."""
    sage = sage or {}
    log = GuardrailLog()
    out: dict[str, Any] = {"gaps": [g for g in answer.get("gaps") or [] if isinstance(g, str)]}
    for section in _SECTIONS:
        kept: list[dict[str, Any]] = []
        items = [dict(i) for i in answer.get(section) or [] if isinstance(i, dict)]
        log.total += len(items)
        for item in sorted(items, key=lambda i: _sort_key(section, i)):
            reason = _common(section, item, log)
            if reason is None and section == "rows":
                reason = _row_problem(item)
            elif reason is None and section in ("crops", "cover_crops"):
                if crop_ids.canonical(item.get("crop_id")) is None:
                    reason = f"crop_id '{item.get('crop_id')}' is not in the vocabulary"
                else:
                    reason = _windows_problem(item, ("plant", "harvest", "seed"))
            elif reason is None and section == "double_crops":
                bad = [c for c in (item.get("winter_crop"), item.get("next_crop"))
                       if crop_ids.canonical(c) is None]  # fmt: skip
                reason = f"crop '{bad[0]}' is not in the vocabulary" if bad else None
            elif reason is None and section == "rotations":
                bad = [c for c in item.get("sequence") or [] if crop_ids.canonical(c) is None]
                reason = f"crop '{bad[0]}' is not in the vocabulary" if bad else None
            if reason is not None:
                log.dropped.append({"item": _label(section, item), "reason": reason})
                continue
            cal = sage.get(crop_ids.canonical(item.get("crop_id")) or "")
            if section == "rows" and item.get("rule_type") == "planting_window" and cal:
                win = {"start": item.get("window_start_mm_dd"), "end": item.get("window_end_mm_dd")}
                if overlaps_sage(win, cal.get("plant")) is False:
                    _flag(section, item, log, "planting window")
            if section == "crops" and cal:
                for k in ("plant", "harvest"):
                    if overlaps_sage(item.get(k), cal.get(k)) is False:
                        _flag(section, item, log, f"{k} window")
            kept.append(item)
        if section == "rows" and len(kept) > MAX_ROWS:
            for item in kept[MAX_ROWS:]:
                log.dropped.append({"item": _label(section, item), "reason": f"over the "
                                    f"{MAX_ROWS}-row cap"})  # fmt: skip
            kept = kept[:MAX_ROWS]
        out[section] = kept
    if log.drift:
        out["gaps"] = [*out["gaps"], DRIFT_GAP]
    return out, log


# --------------------------------------------------------------------------- schema validation

_TYPES = {"string": str, "number": (int, float), "integer": int, "object": dict, "array": list,
          "boolean": bool, "null": type(None)}  # fmt: skip


def _is(v: Any, t: str) -> bool:
    if t in ("number", "integer") and isinstance(v, bool):
        return False
    return isinstance(v, _TYPES[t])


def schema_errors(doc: Any, schema: dict[str, Any], path: str = "$", limit: int = 20) -> list[str]:
    """The JSON-schema subset the output schema uses (type, enum, pattern, objects, arrays)."""
    errs: list[str] = []

    def walk(v: Any, s: dict[str, Any], p: str) -> None:
        if len(errs) >= limit:
            return
        types = s.get("type")
        if types is not None:
            ts = types if isinstance(types, list) else [types]
            if not any(_is(v, t) for t in ts):
                errs.append(f"{p}: expected {'/'.join(ts)}")
                return
        if "enum" in s and v not in s["enum"]:
            errs.append(f"{p}: {v!r} is not one of the allowed values")
        if isinstance(v, str) and "pattern" in s and not re.search(s["pattern"], v):
            errs.append(f"{p}: {v!r} does not match {s['pattern']}")
        if isinstance(v, dict) and "properties" in s:
            for k in s.get("required", []):
                if k not in v:
                    errs.append(f"{p}.{k}: required")
            if s.get("additionalProperties") is False:
                for k in v:
                    if k not in s["properties"]:
                        errs.append(f"{p}.{k}: not allowed")
            for k, sub in s["properties"].items():
                if k in v:
                    walk(v[k], sub, f"{p}.{k}")
        if isinstance(v, list) and "items" in s:
            for i, x in enumerate(v):
                walk(x, s["items"], f"{p}[{i}]")

    walk(doc, schema, path)
    return errs[:limit]


def shift(mmdd: str, days: int) -> str:  # small helper for tests and callers
    d = date(2001, int(mmdd[:2]), int(mmdd[3:])) + timedelta(days=days)
    return f"{d.month:02d}-{d.day:02d}"
