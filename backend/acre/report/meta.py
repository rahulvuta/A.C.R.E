"""Response metadata every API response carries: ``{plan_version, catalog_version, snapshot_hash, request_id}``."""

from __future__ import annotations

import uuid
from functools import lru_cache
from typing import Any

from acre.catalogs import CatalogIndex, load_catalog


@lru_cache(maxsize=1)
def get_index() -> CatalogIndex:
    """The process-wide catalog index (the catalogs are read once)."""
    return CatalogIndex(load_catalog())


def snapshot_hash() -> str | None:
    try:  # metadata only: never fail a response because the snapshot cannot be read
        from acre.weather.snapshot import load_snapshot

        return load_snapshot().snapshot_hash
    except Exception:  # noqa: BLE001
        return None


def response_meta(plan_version: str | None = None, *, index: CatalogIndex | None = None,
                  weather: bool = True) -> dict[str, Any]:
    """``index``: the catalog the response used (default: NC). ``weather=False`` for an answer
    that used no weather (a regional check or profile): its ``snapshot_hash`` is then ``None``
    rather than the Union County snapshot it never read."""
    idx = index or get_index()
    return {
        "plan_version": plan_version,
        "catalog_version": f"{idx.version}:{idx.catalog.manifest.content_hash[:12]}",
        "snapshot_hash": snapshot_hash() if weather else None,
        "request_id": uuid.uuid4().hex,
    }
