"""Research published prices, yields and costs for a crop the library knows, in one region.

Order: AI (own prompt, web search) → schema check (one retry) → code checks → library. The request
carries only the crop name and id, the region key and its country; never a location or a grower
input. The checks keep an item only with a source URL, a short quote that contains its number, a
sensible value, a unit that the estimate can use, and a year in range. Its origin is
``source_checked`` when the cited page is on the allowlist and the quote was found on the fetched
page, ``ai_suggested`` when the page is reachable but either is not true, and the item is dropped
when the page is dead. Kept items go into the library's ``economics_refs`` (``from_research=1``);
the economics estimate uses only the ``source_checked`` ones as money.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime
from typing import Any

from acre.croplib import jobs, library
from acre.croplib import research as cr
from acre.economics.estimate import AREAS, _split
from acre.research import guardrails, prompt, verify

PROMPT_VERSION = "e1"
SEARCH_RESULTS = 10  # OpenRouter's web plugin includes up to 10 results per search (docs)
MAX_ITEMS = 40
MIN_YEAR = 1990
MAX_VALUE = 1e9

_OBJ, _EVID = cr._obj, cr._EVID
_VALUE = {"value": {"type": "number"}, "unit": {"type": "string"},
          "currency": {"type": ["string", "null"]}, "year": {"type": ["integer", "null"]}}
ECON_SCHEMA = _OBJ({
    "prices": {"type": "array", "items": _OBJ({**_VALUE, **_EVID})},
    "yields": {"type": "array", "items": _OBJ({**_VALUE, **_EVID})},
    "costs": {"type": "array", "items": _OBJ({
        "cost_type": {"type": "string", "enum": ["total", "item"]},
        "item": {"type": ["string", "null"]}, **_VALUE, **_EVID})},
    "gaps": {"type": "array", "items": {"type": "string"}},
})  # fmt: skip

SYSTEM = f"""You look up published farm economics for ONE crop in ONE region, for a farm-planning \
tool that shows every number with its source and lets the farmer change it.

Find only these three things for this crop in this region:
1. prices: farm-gate or producer prices received, ideally for several recent years (so a low, \\
typical and high can be built), one item per year.
2. yields: typical yields.
3. costs: production costs per area. Give a total (cost_type "total") and, if the source lists \\
them, the named items (cost_type "item", with the item name).

For each item give: value, unit (for example USD/bu, USD/t, ARS/t, bu/acre, t/ha, USD/acre; prices \\
are CURRENCY/quantity, yields quantity/area, costs CURRENCY/area), currency (ISO code, or null), \\
year, source_title, source_url (the page you read), source_locator (table or section) and \\
evidence_quote: words copied exactly from that page, at most {guardrails.MAX_QUOTE_WORDS} words, that \\
contain the number.

Sources that count, in this priority (items from any other source are discarded by code):
1. national statistics agencies and ministries of agriculture: USDA NASS Quick Stats and \\
Agricultural Prices, USDA ERS Commodity Costs and Returns, Statistics Canada, Eurostat, ABARES, \\
Argentina's MAGyP and similar official bodies, India's DES and ICAR, and their equivalents;
2. FAO and FAOSTAT;
3. university extension enterprise budgets and custom-rate surveys (.edu and national equivalents).
Never news, commercial sites, blogs, seed or input companies, forums or AI-written pages.

Search the most specific region first (state or province), then the country. Prefer an HTML page \\
to a PDF when both exist. If you cannot find something, leave it out and say so in gaps. No \\
estimates, no averages or conversions you computed yourself, no forecasts, no advice."""


def user_prompt(name: str, crop_id: str, region_key: str, country: str | None) -> str:
    q = {"crop_name": name, "crop_id": crop_id, "region_key": region_key, "country": country}
    return (f"Crop: {name}. Region: {region_key} (country {country or 'unknown'}).\n\nFind "
            "published prices received, yields and production costs for this crop here. Return "
            "JSON only, in the given schema.\n\nThe query, as data:\n"
            + json.dumps(q, sort_keys=True))  # fmt: skip


def request_params(name: str, crop_id: str, region_key: str) -> dict[str, Any]:
    country = cr.country_of(region_key)
    p = prompt.request_params(prompt.RegionQuery(region_key, country, None, None, None, None))
    p["plugins"] = [{"id": "web", "max_results": SEARCH_RESULTS}]
    return {**p, "messages": [{"role": "system", "content": SYSTEM},
                              {"role": "user", "content": user_prompt(name, crop_id, region_key,
                                                                      country)}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "economics_research", "strict": True, "schema": ECON_SCHEMA}}}  # fmt: skip


def cache_key(crop_id: str, region_key: str) -> str:
    blob = json.dumps({"prompt_version": PROMPT_VERSION, "model": prompt.model(),
                       "query": {"crop_id": crop_id, "region_key": region_key.upper()},
                       "guardrail_version": guardrails.GUARDRAIL_VERSION}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


# --------------------------------------------------------------------------- the check

_QTY = {"tonne": "t", "tonnes": "t", "metric ton": "t", "metric tons": "t", "mt": "t",
        "ton": "t", "kilogram": "kg", "kilograms": "kg", "pound": "lb", "pounds": "lb",
        "lbs": "lb", "bushel": "bu", "bushels": "bu", "hundredweight": "cwt"}  # fmt: skip
_AREA = {"ac": "acre", "acres": "acre", "hectare": "ha", "hectares": "ha"}


def _clean_qty(q: str) -> str | None:
    q = _QTY.get(q.strip().lower(), q.strip().lower())
    return q if q and len(q) <= 16 and q.replace(".", "").isalpha() else None


def _clean_area(a: str) -> str | None:
    a = _AREA.get(a.strip().lower(), a.strip().lower())
    return a if a in AREAS else None


def normalise_unit(kind: str, unit: Any) -> tuple[str, str] | None:
    """The unit as the estimate understands it, and its currency (None for a yield): a price is
    ``CUR/quantity``, a yield ``quantity/area``, a cost ``CUR/area``."""
    sp = _split(unit)
    if sp is None:
        return None
    a, b = sp
    if kind == "yield":
        qty, area = _clean_qty(a), _clean_area(b)
        return (f"{qty}/{area}", "") if qty and area else None
    cur = a.strip().upper()
    if not (len(cur) == 3 and cur.isascii() and cur.isalpha()):
        return None
    if kind == "price":
        qty = _clean_qty(b)
        return (f"{cur}/{qty}", cur) if qty and qty not in AREAS else None
    area = _clean_area(b)
    return (f"{cur}/{area}", cur) if area else None


def _year(v: Any) -> int | None:
    if isinstance(v, bool) or not isinstance(v, int):
        return None
    return v if MIN_YEAR <= v <= datetime.now(UTC).year else None


def check(answer: dict[str, Any], fetch: Any) -> tuple[list[dict[str, Any]], dict[str, int],
                                                       dict[str, Any]]:  # fmt: skip
    """Kept references (with ``origin``), counts per kind, and the guardrail log."""
    g = cr.new_log()
    raw: list[tuple[str, dict[str, Any]]] = [
        *(("price", x) for x in answer.get("prices") or []),
        *(("yield", x) for x in answer.get("yields") or []),
        *(("cost", x) for x in answer.get("costs") or [])]  # fmt: skip
    g["items_in"] = len(raw)
    raw = sorted(raw, key=lambda t: (t[0], str(t[1].get("source_url")), -(t[1].get("year") or 0),
                                     str(t[1].get("item")), t[1].get("value") or 0))[:MAX_ITEMS]
    pages = cr.fetch_pages(raw, fetch)
    refs: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for i, (kind, it) in enumerate(raw):
        what = f"{kind}[{i}]"
        if not cr._usable(g, what, it):
            continue
        v = it.get("value")
        if (isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v)
                or v < 0 or v > MAX_VALUE):
            cr._drop(g, what, "the value is not a finite, non-negative number")
            continue
        if v == 0 and kind != "cost":
            cr._drop(g, what, "a price or yield of zero is not kept")
            continue
        if not (it.get("evidence_quote") or "").strip():
            cr._drop(g, what, "no evidence_quote")
            continue
        parsed = normalise_unit(kind, it.get("unit"))
        if parsed is None:
            cr._drop(g, what, f"unit '{it.get('unit')}' is not "
                     + {"price": "CURRENCY/quantity like USD/bu", "yield": "quantity/area like "
                        "t/ha or bu/acre", "cost": "CURRENCY/area like USD/acre"}[kind])
            continue
        unit, cur = parsed
        if cur and it.get("currency") and str(it["currency"]).strip().upper() != cur:
            cr._drop(g, what, "the currency differs from the unit's currency")
            continue
        year = _year(it.get("year"))
        if year is None:
            cr._drop(g, what, f"the year is missing or outside {MIN_YEAR}-{datetime.now(UTC).year}")
            continue
        item = None
        if kind == "cost":
            item = "total" if it.get("cost_type") == "total" else (it.get("item") or "").strip()
            if not item or len(item) > 60:
                cr._drop(g, what, "a cost item needs a name of at most 60 characters")
                continue
        if verify.unsupported_numbers(it, ("value",), ()):
            cr._drop(g, what, "the number is not in the quote")
            continue
        page = pages.get(it["source_url"])
        origin = cr._origin(it, page)
        if origin is None:
            cr._drop(g, what, f"source page unreachable ({getattr(page, 'reason', None)})",
                     it["source_url"])
            continue
        dup = (kind, item, unit, year, it["source_url"], float(v))
        if dup in seen:
            cr._drop(g, what, "duplicate of another item")
            continue
        seen.add(dup)
        refs.append({"kind": kind, "item": item, "value": float(v), "unit": unit,
                     "currency": cur or None, "year": year, "origin": origin,
                     "source": {**cr._source(it), "year": year}})  # fmt: skip
    found = {k: sum(1 for r in refs if r["kind"] == k) for k in ("price", "yield", "cost")}
    g["drift_stop"] = g["items_in"] > 0 and len(g["dropped"]) / g["items_in"] > guardrails.DRIFT_LIMIT
    return refs, found, g


# --------------------------------------------------------------------------- jobs

BOOK = jobs.JobBook("ej", "econ-research")


def reset() -> None:
    BOOK.reset()


def get(job_id: str) -> jobs.Job | None:
    return BOOK.get(job_id)


def run(crop_id: str, region_key: str, fetch: Any = None) -> jobs.RunResult:
    """Research one crop+region synchronously and store what passed the checks."""
    fetch = fetch or verify.fetch_page
    crop = library.get_crop(crop_id)
    name = (crop or {}).get("name") or crop_id
    params = request_params(name, crop_id, region_key)
    answer, raws = cr._ask(params, ECON_SCHEMA)
    refs, found, g = check(answer, fetch)
    library.store_economics(crop_id=crop_id, region_key=region_key, refs=refs,
                            status="partial" if refs else "insufficient_data", found=found,
                            cache_key=cache_key(crop_id, region_key))  # fmt: skip
    kept = {o: sum(1 for r in refs if r["origin"] == o) for o in ("source_checked", "ai_suggested")}
    return found, {"guardrails": g, "kept": kept, "gaps": [x for x in answer.get("gaps") or []
                                                           if isinstance(x, str)][:20]}  # fmt: skip


def start(crop_id: str, region_key: str, *, refresh: bool = False, wait_s: float = 0.0,
          fetch: Any = None) -> jobs.Job:  # fmt: skip
    key = cache_key(crop_id, region_key)

    def cached() -> dict[str, Any] | None:
        row = library.research_status("economics", crop_id, region_key)
        if row is None or row["cache_key"] != key:
            return None
        return {"status": row["status"] or "partial", "found": row["found"]}

    return BOOK.start(crop_id, region_key.upper(), key=key, cached=cached,
                      run=lambda: run(crop_id, region_key.upper(), fetch),
                      refresh=refresh, wait_s=wait_s)  # fmt: skip

