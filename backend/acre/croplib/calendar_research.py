"""Research the usual planting and harvest windows of a crop the library knows, in one region.

For a cover crop the two windows are its usual seeding window (stored as ``plant``) and its usual
termination window (stored as ``harvest``). The request carries only the crop name and id, the
region key and its country. An optional location is used by the route only to read the SAGE windows
of its cell for the cross-check (:func:`acre.croplib.research.check_calendars`); it is never sent on.

An item is kept only with a source URL, a short quote that contains its dates, and a reachable page;
its origin is ``source_checked`` when the page is on the allowlist and code found the quote on it,
else ``ai_suggested``. A window that disagrees with SAGE is stored flagged ``manual_check`` and not
used. Results go to the library's ``calendars`` table for the crop and region.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from acre.croplib import jobs, library
from acre.croplib import research as cr
from acre.research import guardrails, prompt, verify

PROMPT_VERSION = "k1"
SEARCH_RESULTS = 10  # OpenRouter's web plugin includes up to 10 results per search (docs)

CAL_SCHEMA = cr._obj({
    "calendars": {"type": "array", "items": cr._obj({
        "plant": cr._WINDOW, "harvest": cr._WINDOW, **cr._EVID})},
    "gaps": {"type": "array", "items": {"type": "string"}},
})  # fmt: skip

SYSTEM = f"""You look up published planting and harvest dates for ONE crop in ONE region, for a \
farm-planning tool that shows every date with its source and a warning that it is unverified.

Find only the usual planting window and the usual harvest window of this crop in this region, as \\
MM-DD ranges (start and end). If the crop is a cover crop, give instead its usual seeding window \\
(in "plant") and its usual termination window (in "harvest"). One calendar item per source, with \\
source_title, source_url (the page you read), source_locator (table or section) and \\
evidence_quote: words copied exactly from that page, at most {guardrails.MAX_QUOTE_WORDS} words, \\
that contain the dates.

Sources that count, in this priority (items from any other source are discarded by code):
1. national statistics agencies and ministries of agriculture (USDA NASS crop progress and usual \\
planting and harvesting dates, Statistics Canada, ABARES, Argentina's MAGyP and similar official \\
bodies, India's DES and ICAR, and their equivalents);
2. FAO and FAOSTAT;
3. university extension services and research institutes (.edu and national equivalents).
Never news, commercial sites, blogs, seed or input companies, forums or AI-written pages.

Search the most specific region first (state or province), then the country. Prefer an HTML page \\
to a PDF when both exist. If you cannot find a source, return no item and say so in gaps. Never \\
guess. No forecasts, no yield or profit claims, no advice."""


def user_prompt(name: str, crop_id: str, role: str, region_key: str, country: str | None) -> str:
    q = {"crop_name": name, "crop_id": crop_id, "role": role, "region_key": region_key,
         "country": country}  # fmt: skip
    return (f"Crop: {name} ({role.replace('_', ' ')}). Region: {region_key} (country "
            f"{country or 'unknown'}).\n\nFind the usual planting and harvest windows here (a cover "
            "crop: seeding and termination windows). Return JSON only, in the given schema."
            "\n\nThe query, as data:\n" + json.dumps(q, sort_keys=True))  # fmt: skip


def request_params(name: str, crop_id: str, role: str, region_key: str) -> dict[str, Any]:
    country = cr.country_of(region_key)
    p = prompt.request_params(prompt.RegionQuery(region_key, country, None, None, None, None))
    p["plugins"] = [{"id": "web", "max_results": SEARCH_RESULTS}]
    return {**p, "messages": [{"role": "system", "content": SYSTEM},
                              {"role": "user", "content": user_prompt(name, crop_id, role,
                                                                      region_key, country)}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "calendar_research", "strict": True, "schema": CAL_SCHEMA}}}  # fmt: skip


def cache_key(crop_id: str, region_key: str) -> str:
    blob = json.dumps({"prompt_version": PROMPT_VERSION, "model": prompt.model(),
                       "query": {"crop_id": crop_id, "region_key": region_key.upper()},
                       "guardrail_version": guardrails.GUARDRAIL_VERSION}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


BOOK = jobs.JobBook("kj", "cal-research")


def reset() -> None:
    BOOK.reset()


def get(job_id: str) -> jobs.Job | None:
    return BOOK.get(job_id)


def run(crop_id: str, region_key: str, sage: dict[str, Any] | None = None,
        fetch: Any = None) -> jobs.RunResult:  # fmt: skip
    fetch = fetch or verify.fetch_page
    crop = library.get_crop(crop_id) or {}
    roles = crop.get("roles") or ["cash_crop"]
    role = "cover_crop" if roles[0] == "cover_crop" else "cash_crop"
    params = request_params(crop.get("name") or crop_id, crop_id, role, region_key)
    answer, raws = cr._ask(params, CAL_SCHEMA)
    g = cr.new_log()
    items = [("calendar", c) for c in answer["calendars"]]
    g["items_in"] = len(items)
    cals = cr.check_calendars(answer["calendars"], crop_id, sage or {},
                              cr.fetch_pages(items, fetch), g)  # fmt: skip
    found = {"calendars": len(cals)}
    library.store_calendars(crop_id=crop_id, region_key=region_key, calendars=cals,
                            status="partial" if cals else "insufficient_data", found=found,
                            cache_key=cache_key(crop_id, region_key))  # fmt: skip
    kept = {o: sum(1 for c in cals if c["origin"] == o) for o in ("source_checked", "ai_suggested")}
    return found, {"guardrails": g, "kept": kept,
                   "gaps": [x for x in answer.get("gaps") or [] if isinstance(x, str)][:20]}  # fmt: skip


def start(crop_id: str, region_key: str, *, sage: dict[str, Any] | None = None,
          refresh: bool = False, wait_s: float = 0.0, fetch: Any = None) -> jobs.Job:  # fmt: skip
    key = cache_key(crop_id, region_key)

    def cached() -> dict[str, Any] | None:
        row = library.research_status("calendars", crop_id, region_key)
        if row is None or row["cache_key"] != key:
            return None
        return {"status": row["status"] or "partial", "found": row["found"]}

    return BOOK.start(crop_id, region_key.upper(), key=key, cached=cached,
                      run=lambda: run(crop_id, region_key.upper(), sage, fetch),
                      refresh=refresh, wait_s=wait_s)  # fmt: skip
