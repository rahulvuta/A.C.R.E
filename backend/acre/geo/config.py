"""Paths and switches shared by the geo modules."""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[2]
GEO_DATA_DIR = BACKEND_ROOT / "data" / "geo"
OFFLINE_ENV = "ACRE_OFFLINE"
CACHE_ENV = "ACRE_CACHE_DIR"


def is_offline() -> bool:
    return os.environ.get(OFFLINE_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def cache_root() -> Path:
    """``ACRE_CACHE_DIR`` (a Railway volume in production), else ``backend/data/cache``."""
    configured = os.environ.get(CACHE_ENV, "").strip()
    return Path(configured) if configured else BACKEND_ROOT / "data" / "cache"
