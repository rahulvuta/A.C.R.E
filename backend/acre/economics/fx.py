"""Exchange rates for showing a sourced price in the grower's currency (card 29).

``data/economics/exchange_rates.csv`` holds the World Bank's official yearly-average rates
(local currency per US dollar; built by ``data/economics/import_market.py``). A conversion goes
through the US dollar using the most recent year both currencies have, and is always returned
with the rate, the year and the source, so the page can show how the figure was reached. A
converted figure is a calculation, never a published price: it is offered beside the original
and used only if the grower takes it.
"""

from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
from typing import Any

from acre.economics import data

FILE = "exchange_rates.csv"


@lru_cache(maxsize=4)
def _load(directory: str) -> dict[str, dict[int, dict[str, Any]]]:
    path = Path(directory) / FILE
    out: dict[str, dict[int, dict[str, Any]]] = {}
    if not path.exists():
        return out
    with path.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            try:
                cur, year, value = r["currency"].strip().upper(), int(r["year"]), float(r["per_usd"])
            except (KeyError, ValueError, AttributeError):
                continue
            if len(cur) != 3 or value <= 0 or not (r.get("source_url") or "").startswith("http"):
                continue
            out.setdefault(cur, {})[year] = {
                "per_usd": value, "year": year, "source": {
                    "title": r.get("source_title"), "url": r.get("source_url"),
                    "locator": r.get("locator"), "retrieved": r.get("retrieved")}}  # fmt: skip
    return out


def clear_cache() -> None:
    _load.cache_clear()


def table() -> dict[str, dict[int, dict[str, Any]]]:
    return _load(str(data.data_dir()))


def known(currency: str | None) -> bool:
    return bool(currency) and currency.strip().upper() in table()  # type: ignore[union-attr]


def rate(src: str, dst: str) -> dict[str, Any] | None:
    """How many ``dst`` one ``src`` buys, from the latest year both have; None if either is
    unknown. ``{"rate", "year", "from", "to", "per_usd": {src, dst}, "source"}``."""
    a, b = (src or "").strip().upper(), (dst or "").strip().upper()
    t = table()
    if a == b or a not in t or b not in t:
        return None
    years = sorted(set(t[a]) & set(t[b]))
    if not years:
        return None
    y = years[-1]
    ra, rb = t[a][y], t[b][y]
    # the source of the rate that is not the dollar's own (both, when neither is USD)
    src_row = rb if b != "USD" else ra
    return {"rate": rb["per_usd"] / ra["per_usd"], "year": y, "from": a, "to": b,
            "per_usd": {a: ra["per_usd"], b: rb["per_usd"]}, "source": src_row["source"]}  # fmt: skip
