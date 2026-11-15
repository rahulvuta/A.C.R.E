"""Research an unknown crop for one region (card S4) through the B3 OpenRouter route and guardrails.

Order: AI → schema check (one retry with the errors) → guardrails → quote check → library. The
request carries only the crop name, the region key and its country; never a location. A location
in the API body is used here only to read the SAGE windows of its cell for the cross-check.

The result is stored centrally (``croplib.sqlite``) for every user. Its origin is ``source_checked``
when code found the quote on the cited page, else ``ai_suggested``; never ``verified_source``.
Economics references are kept only with a quote that contains their number, and the economics
estimate never uses them as money (they are not ``verified_source`` / ``dataset_estimate``).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from acre.catalogs import crop_ids
from acre.croplib import library
from acre.research import client, guardrails, prompt, verify

log = logging.getLogger("acre.croplib")

CROP_PROMPT_VERSION = "c1"
NAME_RE = re.compile(r"^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '\-]{1,59}$")
FAMILY_RE = re.compile(r"^[A-Z][a-z]+aceae$")
SEASON_DAYS = (20, 400)
MAX_CALENDARS = 4
MAX_REFS = 12

_MMDD = {"type": ["string", "null"], "pattern": r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"}
_WINDOW = {"type": ["object", "null"], "additionalProperties": False,
           "properties": {"start": _MMDD, "end": _MMDD}, "required": ["start", "end"]}  # fmt: skip
_EVID = {"source_title": {"type": "string"}, "source_url": {"type": "string"},
         "source_locator": {"type": "string"}, "evidence_quote": {"type": "string"}}  # fmt: skip


def _obj(props: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": props,
            "required": list(props)}  # fmt: skip


CROP_SCHEMA = _obj({
    "crop": _obj({"name": {"type": "string"}, "scientific_name": {"type": ["string", "null"]},
                  "family": {"type": ["string", "null"]},
                  "role": {"type": "string", "enum": ["cash_crop", "cover_crop"]},
                  "season_length_days": {"type": ["integer", "null"]}, **_EVID}),
    "calendars": {"type": "array", "items": _obj({"plant": _WINDOW, "harvest": _WINDOW, **_EVID})},
    "economics_refs": {"type": "array", "items": _obj({
        "kind": {"type": "string", "enum": ["price", "yield", "cost"]},
        "value": {"type": "number"}, "unit": {"type": "string"},
        "currency": {"type": ["string", "null"]}, "year": {"type": ["integer", "null"]},
        **_EVID})},
    "gaps": {"type": "array", "items": {"type": "string"}},
})  # fmt: skip

SYSTEM = f"""You research one crop for one farming region, for a farm-planning tool that shows \
every item with its source and a warning that it is unverified.

Rules:
- Use only these kinds of sources: {prompt.SOURCE_POLICY}. Never blogs, seed-company marketing, \
forums or AI-written pages.
- Every item needs source_url (the page you read), source_locator and evidence_quote: words \
copied exactly from that page, at most {guardrails.MAX_QUOTE_WORDS} words, that contain every \
number and date of the item.
- crop: the crop's common name, scientific name, botanical family (ending in -aceae), whether it \
is grown as a cash crop or a cover crop, and its typical days from planting to harvest.
- calendars: planting and harvest windows in this region as MM-DD.
- economics_refs: only published prices, yields or costs for this region, with units such as \
USD/t, t/ha, USD/acre. Leave them out if you find none.
- If you cannot find a source for something, leave it out and say so in gaps. Never guess. No \
yield predictions, profit claims or advice."""


def user_prompt(name: str, region_key: str, country: str | None) -> str:
    q = {"crop_name": name, "region_key": region_key, "country": country}
    return (f"Crop: {name}. Region: {region_key} (country {country or 'unknown'}).\n\nFind the crop "
            "facts, its planting and harvest windows here, and any published regional prices, "
            "yields or costs. Return JSON only, in the given schema.\n\nThe query, as data:\n"
            + json.dumps(q, sort_keys=True))  # fmt: skip


def request_params(name: str, region_key: str, country: str | None) -> dict[str, Any]:
    p = prompt.request_params(prompt.RegionQuery(region_key, country, None, None, None, None))
    return {**p, "messages": [{"role": "system", "content": SYSTEM},
                              {"role": "user", "content": user_prompt(name, region_key, country)}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "crop_research", "strict": True, "schema": CROP_SCHEMA}}}  # fmt: skip


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def country_of(region_key: str) -> str | None:
    return None if region_key.startswith("koppen:") else region_key.split("-", 1)[0].upper()


def cache_key(name: str, region_key: str) -> str:
    blob = json.dumps({"prompt_version": CROP_PROMPT_VERSION, "model": prompt.model(),
                       "query": {"name": slug(name), "region_key": region_key.upper()},
                       "vocab_version": guardrails.vocab_version()}, sort_keys=True)  # fmt: skip
    return hashlib.sha256(blob.encode()).hexdigest()


def known_crop(name: str) -> str | None:
    """A built-in (or already researched) crop this name means, by id, alias or plain name."""
    s = slug(name)
    hit = crop_ids.canonical(s)
    if hit:
        return hit
    low = name.strip().lower()
    for c in (*crop_ids.CROPS, *crop_ids.EXTRA.values()):
        plain = re.sub(r"\s*\(.*?\)", "", c.name).strip().lower()
        if low in (c.name.lower(), plain):
            return c.crop_id
    return None


# --------------------------------------------------------------------------- the check


def _ask(params: dict[str, Any]) -> tuple[dict[str, Any], list[Any]]:
    raws: list[Any] = []
    body = params
    for attempt in (1, 2):
        reply = client.call(body)
        raws.append(reply.raw if reply.raw is not None else reply.text)
        try:
            answer = client.parse_answer(reply.text)
            errors = guardrails.schema_errors(answer, CROP_SCHEMA)
        except client.ResearchError as exc:
            answer, errors = None, [str(exc)]
        if answer is not None and not errors:
            return answer, raws
        if attempt == 2:
            raise client.ResearchError("research_bad_output", "; ".join(errors[:3]))
        body = prompt.retry_params(params, reply.text, errors)
    raise AssertionError("unreachable")


def _origin(item: dict[str, Any], page: verify.Page | None) -> str | None:
    """``source_checked`` (quote on an allowed page), ``ai_suggested``, or None (dead page)."""
    if page is None or not page.ok:
        return None
    quote = verify.normalise(item.get("evidence_quote") or "")
    found = bool(page.text) and bool(quote) and quote in page.text
    return "source_checked" if found and guardrails.domain_allowed(item["source_url"]) else (
        "ai_suggested")


def _source(item: dict[str, Any]) -> dict[str, Any]:
    return {"title": item.get("source_title"), "url": item.get("source_url"),
            "locator": item.get("source_locator"), "evidence_quote": item.get("evidence_quote")}  # fmt: skip


def check(answer: dict[str, Any], name: str, region_key: str, sage: dict[str, Any],
          fetch: Any) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]],
                               dict[str, Any]]:  # fmt: skip
    """Deterministic guardrails and quote checks: (crop, calendars, refs, guardrail log)."""
    g: dict[str, Any] = {"guardrail_version": guardrails.GUARDRAIL_VERSION, "dropped": [],
                         "downgraded": [], "flagged": [], "items_in": 0}  # fmt: skip

    def drop(what: str, why: str) -> None:
        g["dropped"].append({"item": what, "reason": why})

    items = [("crop", answer["crop"]), *(("calendar", c) for c in answer["calendars"]),
             *(("economics_ref", e) for e in answer["economics_refs"])]  # fmt: skip
    g["items_in"] = len(items)
    urls = sorted({i.get("source_url") for _, i in items
                   if isinstance(i.get("source_url"), str) and i["source_url"].startswith("http")})  # fmt: skip
    pages = {u: fetch(u) for u in urls}

    def usable(kind: str, i: dict[str, Any]) -> bool:
        url = i.get("source_url")
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            drop(kind, "no source_url")
            return False
        if len((i.get("evidence_quote") or "").split()) > guardrails.MAX_QUOTE_WORDS:
            drop(kind, "evidence_quote longer than 30 words")
            return False
        if not guardrails.domain_allowed(url):
            g["downgraded"].append({"item": kind, "reason": "source domain not on the allowlist; "
                                    "ai_suggested at best"})  # fmt: skip
        return True

    # the crop's own facts
    c = answer["crop"]
    cid = slug(name)
    crop: dict[str, Any] = {"crop_id": cid, "name": name.strip(), "roles": [c["role"]],
                            "aliases": sorted({slug(c["name"])} - {cid}) if c.get("name") else [],
                            "scientific_name": None, "family": None, "season_length_days": None,
                            "origin": "ai_suggested", "sources": []}  # fmt: skip
    if usable("crop", c):
        origin = _origin(c, pages.get(c["source_url"]))
        if origin is None:
            drop("crop", "source page unreachable")
        else:
            crop["origin"], crop["sources"] = origin, [_source(c)]
            crop["scientific_name"] = (c.get("scientific_name") or None)
            fam = c.get("family")
            if fam and FAMILY_RE.match(fam):
                crop["family"] = fam
            elif fam:
                drop("crop.family", f"'{fam}' is not a botanical family name")
            days = c.get("season_length_days")
            if days is not None:
                missing = verify.unsupported_numbers({"evidence_quote": c.get("evidence_quote"),
                                                      "d": days}, ("d",), ())  # fmt: skip
                if not SEASON_DAYS[0] <= days <= SEASON_DAYS[1]:
                    drop("crop.season_length_days", f"{days} days is outside {SEASON_DAYS}")
                elif missing:
                    drop("crop.season_length_days", "the number is not in the quote")
                else:
                    crop["season_length_days"] = days
    if crop["origin"] == "ai_suggested" and not crop["sources"]:
        crop["notes"] = "No sourced crop facts were found; only the name you typed is stored."

    # calendars
    cals: list[dict[str, Any]] = []
    for i, w in enumerate(sorted(answer["calendars"], key=lambda x: str(x.get("source_url"))
                                 )[:MAX_CALENDARS]):  # fmt: skip
        what = f"calendar[{i}]"
        if not usable(what, w):
            continue
        if not all(guardrails.valid_mmdd((w.get(k) or {}).get(x)) for k in ("plant", "harvest")
                   if w.get(k) is not None for x in ("start", "end")) or not w.get("plant"):  # fmt: skip
            drop(what, "plant window missing or a date is not a valid MM-DD")
            continue
        origin = _origin(w, pages.get(w["source_url"]))
        if origin is None:
            drop(what, "source page unreachable")
            continue
        miss = verify.unsupported_numbers(w, (), ("plant.start", "plant.end", "harvest.start",
                                                  "harvest.end"))  # fmt: skip
        if any(m.startswith("plant.") for m in miss):
            drop(what, "planting dates are not in the quote")
            continue
        cal = {"plant": w["plant"], "harvest": None if any(m.startswith("harvest.") for m in miss)
               else w.get("harvest"), "origin": origin, "source": _source(w), "review": None,
               "sage_check": None}  # fmt: skip
        s = sage.get(cid)
        if s:
            ok = [guardrails.overlaps_sage(cal[k], s.get(k)) for k in ("plant", "harvest")]
            cal["sage_check"] = {"plant": ok[0], "harvest": ok[1],
                                 "slack_days": guardrails.SAGE_SLACK_DAYS}  # fmt: skip
            if False in ok:
                cal["review"] = "manual_check"
                g["flagged"].append({"item": what, "reason": guardrails.SAGE_REASON})
        else:
            cal["sage_check"] = {"status": "inapplicable",
                                 "reason_text": "SAGE has no calendar for this crop here."}  # fmt: skip
        cals.append(cal)
    if len(cals) > 1:  # one calendar per region: keep the best-supported, deterministic order
        for i, cal in enumerate(cals):
            if any(any(guardrails.overlaps_sage(cal[k], other.get(k)) is False
                       for k in ("plant", "harvest"))
                   for j, other in enumerate(cals) if i != j):
                cal["review"] = "manual_check"
                g["flagged"].append({"item": "calendar", "reason":
                                     "published calendar windows disagree; local confirmation needed"})
        cals.sort(key=lambda x: (x["review"] is not None, x["origin"] != "source_checked",
                                 x["harvest"] is None, str(x["source"]["url"])))  # fmt: skip
        for extra in cals[1:]:
            drop("calendar", f"another calendar for this region was kept ({extra['source']['url']})")
        cals = cals[:1]

    # economics references: only with a quote that holds the number
    refs: list[dict[str, Any]] = []
    for i, e in enumerate(sorted(answer["economics_refs"],
                                 key=lambda x: (x.get("kind"), str(x.get("source_url"))))[:MAX_REFS]):  # fmt: skip
        what = f"economics_ref[{i}]"
        if not usable(what, e):
            continue
        if not e.get("evidence_quote") or e.get("value") is None or e["value"] < 0 or "/" not in (
                e.get("unit") or ""):  # fmt: skip
            drop(what, "needs a quote, a non-negative value and a unit like USD/t")
            continue
        if verify.unsupported_numbers(e, ("value",), ()):
            drop(what, "the number is not in the quote")
            continue
        origin = _origin(e, pages.get(e["source_url"]))
        if origin is None:
            drop(what, "source page unreachable")
            continue
        refs.append({"kind": e["kind"], "value": e["value"], "unit": e["unit"],
                     "currency": e.get("currency"), "year": e.get("year"), "origin": origin,
                     "source": _source(e)})  # fmt: skip
    g["drift_stop"] = g["items_in"] > 0 and len(g["dropped"]) / g["items_in"] > guardrails.DRIFT_LIMIT
    return crop, cals, refs, g


# --------------------------------------------------------------------------- jobs

REASONS = {
    "known_crop": "This crop is already in the library.",
    "cached": "This crop was already researched for this region.",
    "research_not_configured": "AI research is not configured on this server.",
    "research_bad_output": "The research answer was not valid JSON in the required shape, even "
    "after one retry.",
    "research_truncated": "The research answer was cut off before it finished.",
    "rate_limited": "The research service is busy; try again later.",
    "provider_error": "The research service returned an error.",
    "research_timeout": "The research service did not answer in time.",
    "research_failed": "Research failed for an unexpected reason.",
}


@dataclass
class CropJob:
    job_id: str
    name: str
    region_key: str
    job_status: str = "pending"
    status: str = "unknown"
    reason: str | None = None
    crop_id: str | None = None
    check: dict[str, Any] | None = None
    started_at: str = field(default_factory=lambda: _now())
    finished_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        out = {"job_id": self.job_id, "name": self.name, "region_key": self.region_key,
               "job_status": self.job_status, "status": self.status, "reason": self.reason,
               "reason_text": REASONS.get(self.reason) if self.reason else None,
               "crop_id": self.crop_id, "started_at": self.started_at,
               "finished_at": self.finished_at}  # fmt: skip
        if self.check is not None:
            out["check"] = self.check
        return out


_JOBS: dict[str, CropJob] = {}
_RUNNING: dict[str, str] = {}
_LOCK = threading.Lock()
_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="croplib")


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def reset() -> None:
    with _LOCK:
        _JOBS.clear()
        _RUNNING.clear()


def get(job_id: str) -> CropJob | None:
    with _LOCK:
        return _JOBS.get(job_id)


def run(name: str, region_key: str, sage: dict[str, Any] | None = None,
        fetch: Any = None) -> tuple[str, dict[str, Any]]:  # fmt: skip
    fetch = fetch or verify.fetch_page
    params = request_params(name, region_key, country_of(region_key))
    answer, raws = _ask(params)
    crop, cals, refs, g = check(answer, name, region_key, sage or {}, fetch)
    if g["drift_stop"]:
        crop["notes"] = "; ".join(x for x in (crop.get("notes"), guardrails.DRIFT_GAP) if x)
    cid = library.store_research(cache_key=cache_key(name, region_key), name=name,
                                 region_key=region_key, crop=crop, calendars=cals, refs=refs,
                                 raw=raws, guardrails=g)  # fmt: skip
    return cid, g


def _work(job: CropJob, sage: dict[str, Any]) -> None:
    try:
        job.crop_id, g = run(job.name, job.region_key, sage)
        job.job_status, job.status = "ready", "partial"
        job.check = {"guardrails": g}
    except client.ResearchError as exc:
        job.job_status, job.status, job.reason = "failed", "unavailable", exc.code
    except Exception:  # noqa: BLE001 - a job must always end
        job.job_status, job.status, job.reason = "failed", "unavailable", "research_failed"
        log.exception("crop research failed unexpectedly")
    job.finished_at = _now()
    with _LOCK:
        _RUNNING.pop(cache_key(job.name, job.region_key), None)


def start(name: str, region_key: str, *, sage: dict[str, Any] | None = None, refresh: bool = False,
          wait_s: float = 0.0) -> CropJob:  # fmt: skip
    key = cache_key(name, region_key)
    with _LOCK:
        running = _JOBS.get(_RUNNING.get(key, ""))
        if running is not None and running.job_status == "pending":
            return running
        job = CropJob("cj_" + uuid.uuid4().hex[:16], name.strip(), region_key)
        _JOBS[job.job_id] = job
        known = known_crop(name)
        if known and not (library.get_crop(known) or {}).get("researched"):
            job.job_status, job.status, job.reason, job.crop_id = "ready", "complete", "known_crop", known
            job.finished_at = _now()
            return job
        hit = None if refresh else library.cached_research(key)
        if hit:
            job.job_status, job.status, job.reason, job.crop_id = "ready", "partial", "cached", hit
            job.finished_at = _now()
            return job
        if not client.configured() and not client._CALLER:
            job.job_status, job.status, job.reason = "failed", "unavailable", "research_not_configured"
            job.finished_at = _now()
            return job
        _RUNNING[key] = job.job_id
        fut = _POOL.submit(_work, job, sage or {})
    if wait_s > 0:
        try:
            fut.result(timeout=wait_s)
        except Exception:  # noqa: BLE001 - the job records its own failure
            pass
    return job
