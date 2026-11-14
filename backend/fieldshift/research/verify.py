"""The code check of an AI research answer (card B3). Nothing the model says is taken on trust.

* Each cited page is fetched. A quote found on it (after normalising case, spacing, quotes and
  dashes) makes the item ``source_checked``; not found, ``ai_suggested``. A dead page drops the item.
* Every number in a rule must appear in its quote, or the rule is downgraded to ``manual_check``:
  its condition and window are removed, so the rule engine can only ask a person to check it.
* Rows that disagree (same crop, type, stage and neighbours, different numbers or verdict) are both
  kept, each naming the other in ``conflicts_with``. Nothing is merged.

Pages are fetched with a generic User-Agent; no farm or location data is in any request.
"""

from __future__ import annotations

import html
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from fieldshift.catalogs import crop_ids

USER_AGENT = "FieldShift-research-check/1.0"
FETCH_TIMEOUT_S = 20.0
MAX_PAGE_BYTES = 5_000_000
_TAGS = re.compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", re.S | re.I)
_SPACE = re.compile(r"\s+")
_TRANS = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " ",
                        "−": "-", "°": " "})  # fmt: skip
_NUM = re.compile(r"-?\d+(?:[.,]\d+)?")
_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
           "october", "november", "december"]  # fmt: skip


def normalise(text: str) -> str:
    t = html.unescape(_TAGS.sub(" ", text or "")).translate(_TRANS).lower()
    t = re.sub(r"[^\w\s'\"%.,;:/()-]", " ", t)
    return _SPACE.sub(" ", t).strip()


@dataclass
class Page:
    ok: bool
    text: str = ""
    reason: str | None = None


def fetch_page(url: str, client: httpx.Client | None = None) -> Page:
    if not url.startswith(("https://", "http://")):
        return Page(False, reason="not_a_web_url")
    own = client is None
    c = client or httpx.Client(timeout=FETCH_TIMEOUT_S, follow_redirects=True,
                               headers={"User-Agent": USER_AGENT})  # fmt: skip
    try:
        r = c.get(url)
    except httpx.HTTPError:
        return Page(False, reason="unreachable")
    finally:
        if own:
            c.close()
    if r.status_code >= 400:
        return Page(False, reason=f"http_{r.status_code}")
    ctype = r.headers.get("content-type", "")
    if "pdf" in ctype:
        return Page(True, text="", reason="pdf_not_checked")  # reachable, but quote not checkable
    return Page(True, text=normalise(r.text[:MAX_PAGE_BYTES]))


def _num_forms(x: float) -> set[str]:
    out = {f"{x:g}"}
    if float(x).is_integer():
        out.add(str(int(x)))
    out.add(f"{x:g}".replace(".", ","))
    return out


def numbers_in(text: str) -> set[str]:
    return {m.replace(",", ".") if "," in m and len(m.split(",")[1]) != 3 else m
            for m in _NUM.findall(text or "")}  # fmt: skip


def _date_forms(mmdd: str) -> list[str]:
    m, d = int(mmdd[:2]), int(mmdd[3:])
    name = _MONTHS[m - 1]
    return [f"{name} {d}", f"{d} {name}", f"{name[:3]} {d}", f"{d} {name[:3]}", f"{d}/{m}",
            f"{m}/{d}", mmdd]  # fmt: skip


def unsupported_numbers(row: dict[str, Any]) -> list[str]:
    """Numbers (and window dates) of a row that its quote does not contain."""
    quote = normalise(row.get("evidence_quote") or "")
    nums = {n.lstrip("-") for n in numbers_in(quote)}
    missing: list[str] = []
    for k in ("value_min", "value_max"):
        v = row.get(k)
        if isinstance(v, int | float) and not isinstance(v, bool):
            if not ({f.lstrip("-") for f in _num_forms(float(v))} & nums):
                missing.append(f"{k}={v:g}")
    for k in ("window_start_mm_dd", "window_end_mm_dd"):
        v = row.get(k)
        if isinstance(v, str) and len(v) == 5 and not any(f in quote for f in _date_forms(v)):
            missing.append(f"{k}={v}")
    return missing


_CONFLICT_KEY = ("crop_id", "rule_type", "growth_stage", "management_action", "previous_crop_id",
                 "next_crop_id", "condition_key", "production_system")  # fmt: skip
_CONFLICT_VALUE = ("value_min", "value_max", "operator", "suitability", "window_start_mm_dd",
                   "window_end_mm_dd")  # fmt: skip


def mark_conflicts(rows: list[dict[str, Any]]) -> None:
    for i, a in enumerate(rows):
        for b in rows[i + 1:]:
            if all(a.get(k) == b.get(k) for k in _CONFLICT_KEY) and any(
                    a.get(k) != b.get(k) for k in _CONFLICT_VALUE):  # fmt: skip
                a.setdefault("_conflicts", []).append(b["rule_id"])
                b.setdefault("_conflicts", []).append(a["rule_id"])


@dataclass
class CheckLog:
    dropped: list[dict[str, str]] = field(default_factory=list)
    downgraded: list[dict[str, Any]] = field(default_factory=list)
    checked: int = 0
    found: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {"items_checked": self.checked, "quotes_found": self.found,
                "dropped": self.dropped, "downgraded": self.downgraded}  # fmt: skip


def _evidence_origin(item: dict[str, Any], pages: dict[str, Page], log: CheckLog,
                     what: str) -> str | None:  # fmt: skip
    """``source_checked`` / ``ai_suggested``, or ``None`` (dropped) for a dead or missing page."""
    url = str(item.get("source_url") or "")
    quote = str(item.get("evidence_quote") or "")
    if not url or not quote:
        log.dropped.append({"item": what, "reason": "no source_url or evidence_quote"})
        return None
    if len(quote.split()) > 30:
        log.dropped.append({"item": what, "reason": "evidence_quote longer than 30 words"})
        return None
    page = pages[url]
    log.checked += 1
    if not page.ok:
        log.dropped.append({"item": what, "reason": f"source page {page.reason}"})
        return None
    if page.text and normalise(quote) in page.text:
        log.found += 1
        return "source_checked"
    return "ai_suggested"


def check_answer(answer: dict[str, Any], region: dict[str, Any],
                 fetch: Callable[[str], Page] = fetch_page) -> tuple[dict[str, Any], CheckLog]:  # fmt: skip
    """Verified rows and profile entries, each with its ``origin``; and what was done to them."""
    log = CheckLog()
    items = [*(answer.get("rows") or []), *(answer.get("crops") or []),
             *(answer.get("cover_crops") or []), *(answer.get("rotations") or []),
             *(answer.get("double_crops") or [])]  # fmt: skip
    urls = sorted({str(i.get("source_url")) for i in items if isinstance(i, dict)
                   and i.get("source_url")})  # fmt: skip
    pages = {u: fetch(u) for u in urls}
    for i in items:
        if isinstance(i, dict) and i.get("source_url") and str(i["source_url"]) not in pages:
            pages[str(i["source_url"])] = fetch(str(i["source_url"]))
    key = region["region_key"]

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in answer.get("rows") or []:
        if not isinstance(r, dict):
            continue
        rid = str(r.get("rule_id") or "")
        cid = crop_ids.canonical(r.get("crop_id"))
        if not rid or rid in seen or cid is None:
            log.dropped.append({"item": rid or "row", "reason": "missing, duplicate or unknown "
                                "rule or crop id"})  # fmt: skip
            continue
        origin = _evidence_origin(r, pages, log, rid)
        if origin is None:
            continue
        seen.add(rid)
        row = {**r, "crop_id": cid, "origin": origin, "region_key": key,
               "country": region.get("country"), "admin1": region.get("admin1"),
               "koppen": region.get("koppen")}  # fmt: skip
        for f in ("previous_crop_id", "next_crop_id"):
            if row.get(f):
                row[f] = crop_ids.canonical(row[f])
        missing = unsupported_numbers(row)
        if missing:
            log.downgraded.append({"rule_id": rid, "numbers_not_in_quote": missing})
            note = f"numbers not in the quote ({', '.join(missing)}); check with an adviser"
            row["limitations"] = "; ".join(x for x in (row.get("limitations"), note) if x)
            for f in ("condition_key", "operator", "window_start_mm_dd", "window_end_mm_dd",
                      "suitability"):  # fmt: skip
                row[f] = None  # the engine can only return manual_check for this row now
        rows.append(row)
    mark_conflicts(rows)
    for row in rows:
        row["conflicts_with"] = ";".join(sorted(row.pop("_conflicts", [])))

    def entries(section: str, id_field: str | None) -> list[dict[str, Any]]:
        out = []
        for e in answer.get(section) or []:
            if not isinstance(e, dict):
                continue
            label = str(e.get(id_field) if id_field else e.get("label"))
            if id_field and crop_ids.canonical(e.get(id_field)) is None:
                log.dropped.append({"item": label, "reason": f"unknown crop id in {section}"})
                continue
            origin = _evidence_origin(e, pages, log, f"{section}:{label}")
            if origin is None:
                continue
            src = {"title": e.get("source_title"), "url": e.get("source_url"),
                   "locator": e.get("source_locator"), "evidence_quote": e.get("evidence_quote")}  # fmt: skip
            out.append({**{k: v for k, v in e.items() if k not in _EVIDENCE_KEYS},
                        "origin": origin, "sources": [src]})  # fmt: skip
        return out

    crops = []
    for c in entries("crops", "crop_id"):
        cid = crop_ids.canonical(c["crop_id"])
        if not (isinstance(c.get("plant"), dict) and c["plant"].get("start")):
            continue
        crops.append({"crop_id": cid, "name": crop_ids.info(cid).name,  # type: ignore[union-attr]
                      "roles": [crop_ids.info(cid).role.replace("_crop", "")],  # type: ignore[union-attr]
                      "calendar": {"plant": c["plant"], "harvest": c.get("harvest"),
                                   "origin": c["origin"], "source": c["sources"][0]}})  # fmt: skip
    profile = {
        "crops": crops,
        "cover_crops": [{**c, "crop_id": crop_ids.canonical(c["crop_id"])}
                        for c in entries("cover_crops", "crop_id")],
        "rotations": [{**r, "sequence": [crop_ids.canonical(x) or x for x in r.get("sequence")
                                         or []]} for r in entries("rotations", None)],
        "double_crops": entries("double_crops", "winter_crop"),
        "gaps": [g for g in answer.get("gaps") or [] if isinstance(g, str)][:50],
    }  # fmt: skip
    return {"rows": rows, "profile": profile}, log


_EVIDENCE_KEYS = {"source_title", "source_url", "source_locator", "evidence_quote"}
