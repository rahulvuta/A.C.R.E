"""The catalog an analysis uses for a location (sync point 2 of docs/global/plan.md).

North Carolina uses the NC v2 catalog (verified). Anywhere else uses B's
``catalog_for_location`` (B2) once it exists; until then an **empty** catalog, so every rule is
unknown and no NC rule can ever reach a non-NC result.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from fieldshift.catalogs.index import CatalogIndex
from fieldshift.catalogs.loader import Catalog, CatalogManifest
from fieldshift.report.meta import get_index

EMPTY_CATALOG_VERSION = "none"

NO_CATALOG_STATE: dict[str, Any] = {
    "status": "unknown",
    "origin": None,
    "region_key": None,
    "reason": "no_regional_catalog",
    "reason_text": (
        "No regional guidance is loaded for this place yet, so no rule is checked; the weather "
        "results still apply."
    ),
}


@lru_cache(maxsize=1)
def empty_index() -> CatalogIndex:
    """A catalog with no crops, rules or fertilizers."""
    manifest = CatalogManifest(
        version=EMPTY_CATALOG_VERSION,
        content_hash=hashlib.sha256(b"empty").hexdigest(),
        loaded_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        files={},
    )
    return CatalogIndex(Catalog(version=EMPTY_CATALOG_VERSION, directory=Path("."), crops=[],
                                rules=[], fertilizers=[], issues=[], manifest=manifest))  # fmt: skip


def catalog_for(latitude: float, longitude: float, *, in_nc: bool) -> tuple[CatalogIndex,
                                                                             dict[str, Any] | None]:  # fmt: skip
    """``(index, catalog_state)``. ``catalog_state`` is None in NC (the verified catalog)."""
    if in_nc:
        return get_index(), None
    try:  # B2's library call, when it lands
        from fieldshift.catalogs.regional import catalog_for_location  # type: ignore[import-not-found]
    except ImportError:
        return empty_index(), dict(NO_CATALOG_STATE)
    index, state = catalog_for_location({"latitude": latitude, "longitude": longitude})
    return index, state
