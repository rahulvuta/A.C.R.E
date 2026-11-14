"""What the research step sends to Claude (card B3), and the JSON shape it must answer in.

Privacy: the request is built only from a :class:`RegionQuery` (country, admin1, climate class and
a crop list). It has no field for coordinates, a farm, a boundary or a grower, so none can be sent.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

from fieldshift.catalogs import crop_ids, validate

DEFAULT_MODEL = "claude-sonnet-5-5"
MODEL_ENV = "FIELDSHIFT_RESEARCH_MODEL"
MAX_TOKENS = 32000
MAX_SEARCHES = 8
MAX_FETCHES = 12
QUOTE_WORDS = 30
SOURCE_POLICY = ("government agencies and ministries of agriculture, FAO and other UN bodies, "
                 "universities and their extension services, national agricultural research "
                 "institutes (e.g. INTA, ICAR, INRAE), and peer-reviewed papers")  # fmt: skip


def model() -> str:
    return os.environ.get(MODEL_ENV, "").strip() or DEFAULT_MODEL


@dataclass(frozen=True)
class RegionQuery:
    """Everything research may know about the place. Deliberately no coordinates."""

    region_key: str
    country: str | None
    admin1: str | None
    admin1_name: str | None
    country_name: str | None
    koppen: str | None
    crops: tuple[str, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict[str, Any]:
        return {"region_key": self.region_key, "country": self.country,
                "country_name": self.country_name, "admin1": self.admin1,
                "admin1_name": self.admin1_name, "koppen": self.koppen,
                "crops": list(self.crops)}  # fmt: skip


_MMDD = {"type": ["string", "null"], "pattern": r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"}
_EVIDENCE = {
    "source_title": {"type": "string"},
    "source_url": {"type": "string"},
    "source_locator": {"type": "string"},
    "evidence_quote": {"type": "string"},
}
_WINDOW = {"type": ["object", "null"], "additionalProperties": False,
           "properties": {"start": _MMDD, "end": _MMDD}, "required": ["start", "end"]}  # fmt: skip


def _obj(props: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": props,
            "required": list(props)}  # fmt: skip


ROW_SCHEMA = _obj({
    "rule_id": {"type": "string"},
    "crop_id": {"type": "string"},
    "rule_type": {"type": "string", "enum": sorted(validate.RULE_TYPES)},
    "growth_stage": {"type": ["string", "null"]},
    "management_action": {"type": ["string", "null"]},
    "production_system": {"type": ["string", "null"]},
    "previous_crop_id": {"type": ["string", "null"]},
    "next_crop_id": {"type": ["string", "null"]},
    "window_start_mm_dd": _MMDD,
    "window_end_mm_dd": _MMDD,
    "condition_key": {"type": ["string", "null"]},
    "operator": {"type": ["string", "null"], "enum": [*sorted(validate.OPERATORS), None]},
    "value_min": {"type": ["number", "null"]},
    "value_max": {"type": ["number", "null"]},
    "unit": {"type": ["string", "null"], "enum": [*sorted(validate.UNITS), None]},
    "suitability": {"type": ["string", "null"], "enum": [*sorted(validate.SUITABILITIES), None]},
    "applies_when": {"type": "string"},
    "guidance": {"type": "string"},
    "limitations": {"type": ["string", "null"]},
    **_EVIDENCE,
})  # fmt: skip
CROP_SCHEMA = _obj({"crop_id": {"type": "string"}, "plant": _WINDOW, "harvest": _WINDOW,
                    **_EVIDENCE})  # fmt: skip
COVER_SCHEMA = _obj({"crop_id": {"type": "string"}, "seed": _WINDOW,
                     "gap_days": {"type": ["integer", "null"]}, **_EVIDENCE})  # fmt: skip
ROTATION_SCHEMA = _obj({"label": {"type": "string"},
                        "sequence": {"type": "array", "items": {"type": "string"}}, **_EVIDENCE})  # fmt: skip
DOUBLE_SCHEMA = _obj({"winter_crop": {"type": "string"}, "next_crop": {"type": "string"},
                      **_EVIDENCE})  # fmt: skip
OUTPUT_SCHEMA = _obj({
    "rows": {"type": "array", "items": ROW_SCHEMA},
    "crops": {"type": "array", "items": CROP_SCHEMA},
    "cover_crops": {"type": "array", "items": COVER_SCHEMA},
    "rotations": {"type": "array", "items": ROTATION_SCHEMA},
    "double_crops": {"type": "array", "items": DOUBLE_SCHEMA},
    "gaps": {"type": "array", "items": {"type": "string"}},
})  # fmt: skip

SYSTEM = f"""You research published agricultural guidance for one region, for a farm-planning \
tool that shows every item to the farmer with its source and a warning that it is unverified.

Rules:
- Use only these kinds of sources: {SOURCE_POLICY}. Never blogs, seed-company marketing, forums \
or AI-written pages.
- Every item needs source_url (the page you read), source_locator (section, table or page) and \
evidence_quote: words copied exactly from that page, at most {QUOTE_WORDS} words, that support the \
item. Every number in a rule (value_min, value_max, window dates) must appear in its quote.
- If sources disagree, return each as its own row; never merge or average them.
- If you cannot find a source for something, leave it out and say so in gaps. Never guess.
- No yields, prices, profit, erosion or water-saving figures.
- Crop ids: {", ".join(c.crop_id for c in crop_ids.CROPS)}.
- Units: {", ".join(sorted(validate.UNITS))}. Leave a number out if its unit is not listed.
- Dates are MM-DD. rule_id is lowercase snake case, unique, prefixed with the region key."""


def user_prompt(q: RegionQuery) -> str:
    where = ", ".join(x for x in (q.admin1_name or q.admin1, q.country_name or q.country) if x)
    return (
        f"Region: {where or q.region_key} (region key {q.region_key}; Köppen climate class "
        f"{q.koppen or 'unknown'}).\nCrops of interest: {', '.join(q.crops) or 'the main field crops'}."
        "\n\nFind: planting and harvest windows per crop; cover crops used here with seeding windows "
        "and how long before the next crop they are ended; common rotations and double-crop "
        "options; and rotation, planting-window and termination-timing rules. Return JSON only, "
        "in the given schema.\n\nThe query, as data:\n" + json.dumps(q.as_dict(), sort_keys=True)
    )


def request_params(q: RegionQuery) -> dict[str, Any]:
    """The Messages API request (kwargs for ``client.beta.messages.stream``)."""
    return {
        "model": model(),
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": user_prompt(q)}],
        "tools": [
            {"type": "web_search_20260209", "name": "web_search", "max_uses": MAX_SEARCHES},
            {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": MAX_FETCHES},
        ],
        "output_config": {"effort": "high",
                          "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        # a policy decline is retried on a fallback model chosen by the API
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    }  # fmt: skip
