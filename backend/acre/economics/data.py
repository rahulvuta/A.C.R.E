"""Economics reference data (E0): sourced CSVs in ``backend/data/economics/`` (card S3).

Files (every row needs a source URL; a row without one, or with a bad number, is dropped and
reported, never guessed):

* ``prices.csv``: region_key, crop_id, unit, currency, low, typical, high, years, source_title,
  source_url, locator, retrieved
* ``yields.csv``: region_key, crop_id, value, unit, year, source_title, source_url, locator,
  retrieved
* ``costs.csv``: region_key, crop_id, item, value, unit, currency, year, source_title,
  source_url, locator, retrieved
* ``custom_rates.csv``: region_key, operation, equipment, value, unit, currency, year,
  source_title, source_url, locator, retrieved
* ``market_prices.csv``: region_key, crop_id, unit, currency, low, typical, high, years,
  price_type (wholesale or retail), markets, source_title, source_url, locator, retrieved.
  Prices paid in town markets (WFP), in local currency. They are shown beside the producer
  price and are never used as the crop's price unless the grower takes them.
* ``exchange_rates.csv`` is read by :mod:`acre.economics.fx`.

An optional ``origin`` column may say ``verified_source`` (default) or ``dataset_estimate``.
Yield and cost rows may add ``area_basis``: ``harvested``, ``planted`` or ``unknown``.
``ACRE_ECONOMICS_DIR`` points elsewhere (tests use labelled synthetic fixtures).
"""

from __future__ import annotations

import csv
import math
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from acre.catalogs import crop_ids

DIR_ENV = "ACRE_ECONOMICS_DIR"
DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "economics"
SOURCE_COLS = ("source_title", "source_url", "locator", "retrieved")
ORIGINS = {"verified_source", "dataset_estimate"}
FILES: dict[str, tuple[str, ...]] = {
    "prices": ("region_key", "crop_id", "unit", "currency", "low", "typical", "high", "years"),
    "yields": ("region_key", "crop_id", "value", "unit", "year"),
    "costs": ("region_key", "crop_id", "item", "value", "unit", "currency", "year"),
    "custom_rates": ("region_key", "operation", "equipment", "value", "unit", "currency", "year"),
    # Prices paid in town markets (WFP), kept apart from producer prices: card 29.
    "market_prices": ("region_key", "crop_id", "unit", "currency", "low", "typical", "high", "years",
                      "price_type", "markets"),
}
NUMERIC = {"low", "typical", "high", "value"}


def data_dir() -> Path:
    v = os.environ.get(DIR_ENV, "").strip()
    return Path(v) if v else DEFAULT_DIR


@dataclass
class Tables:
    prices: list[dict[str, Any]] = field(default_factory=list)
    yields: list[dict[str, Any]] = field(default_factory=list)
    costs: list[dict[str, Any]] = field(default_factory=list)
    custom_rates: list[dict[str, Any]] = field(default_factory=list)
    market_prices: list[dict[str, Any]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    present: dict[str, bool] = field(default_factory=dict)


def _num(v: str | None) -> float | None:
    if v is None or not str(v).strip():
        return None
    x = float(str(v).replace(",", ""))
    if not math.isfinite(x):
        raise ValueError("not a finite number")
    return x


def _row(name: str, n: int, raw: dict[str, str], t: Tables) -> dict[str, Any] | None:
    def bad(msg: str) -> None:
        t.issues.append({"file": f"{name}.csv", "row": n, "message": msg})

    r = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in raw.items() if k}
    if not r.get("source_url", "").startswith(("https://", "http://")):
        bad("no source_url; row dropped")
        return None
    out: dict[str, Any] = {k: (r.get(k) or None) for k in (*FILES[name], *SOURCE_COLS)}
    for k in FILES[name]:
        if k in NUMERIC:
            try:
                out[k] = _num(r.get(k))
            except ValueError:
                bad(f"{k} is not a number; row dropped")
                return None
    if not out.get("region_key") or not out.get("unit"):
        bad("region_key and unit are required; row dropped")
        return None
    if "crop_id" in out:
        cid = crop_ids.canonical(out["crop_id"]) or (out["crop_id"] or "").strip().lower()
        if not cid:
            bad("crop_id is required; row dropped")
            return None
        out["crop_id"] = cid
    origin = r.get("origin") or "verified_source"
    if origin not in ORIGINS:
        bad(f"origin must be one of {sorted(ORIGINS)}; row dropped")
        return None
    out["origin"] = origin
    if name in {"yields", "costs"} and r.get("area_basis"):
        basis = r["area_basis"].lower()
        if basis not in {"harvested", "planted", "unknown"}:
            bad("area_basis must be harvested, planted or unknown; row dropped")
            return None
        out["area_basis"] = basis
    if name in {"prices", "market_prices"}:
        if name == "market_prices" and out.get("price_type") not in {"wholesale", "retail"}:
            bad("price_type must be wholesale or retail; row dropped")
            return None
        vals = [out[k] for k in ("low", "typical", "high")]
        if out["typical"] is None:
            bad("typical price is required; row dropped")
            return None
        known = [v for v in vals if v is not None]
        if any(v < 0 for v in known) or known != sorted(known):
            bad("prices must be non-negative and low <= typical <= high; row dropped")
            return None
    elif out.get("value") is None or out["value"] < 0:
        bad("value is required and non-negative; row dropped")
        return None
    return out


def load(directory: Path | None = None) -> Tables:
    return _load(str(directory or data_dir()))


@lru_cache(maxsize=4)
def _load(directory: str) -> Tables:
    t = Tables()
    for name in FILES:
        p = Path(directory) / f"{name}.csv"
        t.present[name] = p.exists()
        if not p.exists():
            continue
        with p.open(encoding="utf-8", newline="") as f:
            rows = [x for x in csv.DictReader(f)]
        for n, raw in enumerate(rows, start=2):
            r = _row(name, n, raw, t)
            if r is not None:
                getattr(t, name).append(r)
    return t


def clear_cache() -> None:
    _load.cache_clear()


def source_of(r: dict[str, Any]) -> dict[str, Any]:
    return {"title": r.get("source_title"), "url": r.get("source_url"),
            "locator": r.get("locator"), "retrieved": r.get("retrieved"),
            "region_key": r.get("region_key"),
            **({"years": r["years"]} if r.get("years") else {}),
            **({"year": r["year"]} if r.get("year") else {})}  # fmt: skip
