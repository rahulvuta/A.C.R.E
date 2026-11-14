"""Catalog v3 rows: the v2 columns plus region and provenance columns (card B2).

A v3 ``crop_rules.csv`` (in ``data/catalogs/v3/`` or a region profile folder) has every v2 column
plus :data:`V3_COLUMNS`. Each row must say its ``region_key`` and ``origin``. v1 and v2 files are
never rewritten: their rows load as ``origin: verified_source, region_key: US-NC`` (model defaults).

A row with an error is dropped and reported; one bad row never blocks the rest.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

from fieldshift.catalogs import validate
from fieldshift.catalogs.loader import _parse_rule, _RowParser
from fieldshift.catalogs.models import CropRule, ValidationIssue

V3_COLUMNS = ["region_key", "country", "admin1", "koppen", "origin", "evidence_quote",
              "limitations", "conflicts_with", "review"]  # fmt: skip
#: ``review`` may only be blank or ``manual_check`` (a row the code check could not support).
REVIEW_VALUES = {None, "manual_check"}
ORIGINS = {"nasa_measured", "nasa_modeled", "calculation", "verified_source", "source_checked",
           "ai_suggested", "grower", "assumed", "dataset_estimate"}  # fmt: skip
#: Origins a catalog rule row may carry (weather and calculation origins are not rule origins).
RULE_ORIGINS = {"verified_source", "source_checked", "ai_suggested", "dataset_estimate"}
FILE = "crop_rules.csv"
HEADER = [*validate.EXPECTED_HEADERS[validate.RULES_FILE], *V3_COLUMNS]
MAX_QUOTE_WORDS = 30


def parse_rules_text(text: str, crop_ids: set[str] | None = None
                     ) -> tuple[list[CropRule], list[ValidationIssue]]:  # fmt: skip
    """Parse v3 CSV text. ``crop_ids`` (if given) must contain every crop a row names."""
    issues: list[ValidationIssue] = []
    reader = csv.DictReader(io.StringIO(text))
    header = [h.strip() for h in (reader.fieldnames or [])]
    missing = [c for c in HEADER if c not in header]
    if missing:
        return [], [ValidationIssue(FILE, 1, "header", "error",
                                    f"missing column(s) {', '.join(missing)}", "header_missing")]  # fmt: skip
    rows: list[tuple[int, CropRule]] = []
    seen: set[str] = set()
    for n, raw in enumerate(reader, start=2):
        p = _RowParser(FILE, n, raw, issues)
        rule = _parse_rule(p)
        before = len([i for i in issues if i.row == n and i.severity == "error"])
        extra = {c: p.text(c) for c in V3_COLUMNS}
        if not extra["region_key"]:
            issues.append(ValidationIssue(FILE, n, "region_key", "error",
                                          "region_key is required in v3", "v3_region_missing"))  # fmt: skip
        if extra["origin"] not in RULE_ORIGINS:
            issues.append(ValidationIssue(FILE, n, "origin", "error",
                                          f"origin must be one of {sorted(RULE_ORIGINS)}",
                                          "v3_origin_invalid"))  # fmt: skip
        if extra["review"] not in REVIEW_VALUES:
            issues.append(ValidationIssue(FILE, n, "review", "error",
                                          "review must be blank or manual_check",
                                          "v3_review_invalid"))  # fmt: skip
        quote = extra["evidence_quote"]
        if quote and len(quote.split()) > MAX_QUOTE_WORDS:
            issues.append(ValidationIssue(FILE, n, "evidence_quote", "error",
                                          f"evidence_quote is longer than {MAX_QUOTE_WORDS} words",
                                          "v3_quote_too_long"))  # fmt: skip
        errors = len([i for i in issues if i.row == n and i.severity == "error"])
        if rule is None or errors > before or errors:
            continue
        if rule.rule_id in seen:
            issues.append(ValidationIssue(FILE, n, "rule_id", "error",
                                          f"duplicate rule_id '{rule.rule_id}'", "id_duplicate"))  # fmt: skip
            continue
        seen.add(rule.rule_id)
        rows.append((n, rule.model_copy(update={k: v for k, v in extra.items() if v is not None})))
    if crop_ids is not None:
        issues += validate.validate_rules(rows, crop_ids)
    bad = {i.row for i in issues if i.severity == "error"}
    return [r for n, r in rows if n not in bad], issues


def load_rules(path: Path, crop_ids: set[str] | None = None
               ) -> tuple[list[CropRule], list[ValidationIssue]]:  # fmt: skip
    if not path.exists():
        return [], []
    return parse_rules_text(path.read_text(encoding="utf-8"), crop_ids)


def conflicts(rule: CropRule) -> list[str]:
    return [x.strip() for x in (rule.conflicts_with or "").split(";") if x.strip()]
