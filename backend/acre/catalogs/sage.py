"""SAGE crop calendars (Sacks et al. 2010) at a point: planting and harvest windows per crop.

The bundled ``data/geo/sage_calendars_0p5.npz`` holds day-of-year layers on SAGE's 0.5° grid (see
``data/geo/build_sage.py``). Every window is ``origin: dataset_estimate``: gridded estimates from
national and sub-national reports (mostly circa 1990-2000), not advice and not this farm's dates.

Cells that exist only in SAGE's *filled* file were extrapolated by the authors from neighbouring
reports. They are kept, marked ``extrapolated: true``, and also listed as gaps.
Windows can cross New Year (Southern Hemisphere summer crops): ``start`` after ``end`` in MM-DD.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache
from typing import Any

import numpy as np

from acre.geo.config import GEO_DATA_DIR

NPZ_PATH = GEO_DATA_DIR / "sage_calendars_0p5.npz"
META_PATH = GEO_DATA_DIR / "sage_meta.json"
ORIGIN = "dataset_estimate"


class SageUnavailable(RuntimeError):
    """The bundled calendars are missing or unreadable."""


def mm_dd(doy: int) -> str:
    """Day of year (1-365, non-leap reference year) as ``MM-DD``."""
    d = date(2001, 1, 1) + timedelta(days=int(doy) - 1)
    return f"{d.month:02d}-{d.day:02d}"


@dataclass(frozen=True)
class Window:
    start: str  # MM-DD
    end: str  # MM-DD, may be before start (crosses New Year)
    typical: str | None  # SAGE's median day, MM-DD

    @property
    def crosses_new_year(self) -> bool:
        return self.end < self.start

    def as_dict(self) -> dict[str, Any]:
        return {"start": self.start, "end": self.end, "typical": self.typical,
                "crosses_new_year": self.crosses_new_year}  # fmt: skip


@dataclass(frozen=True)
class CropCalendar:
    crop_id: str
    name: str
    plant: Window
    harvest: Window | None  # None when SAGE gives a planting window but no harvest window
    cell: str
    note: str = ""
    extrapolated: bool = False
    origin: str = ORIGIN

    def as_dict(self) -> dict[str, Any]:
        return {
            "plant": self.plant.as_dict(),
            "harvest": self.harvest.as_dict() if self.harvest else None,
            "origin": self.origin,
            "source": source(),
            "resolution_deg": 0.5,
            "sage_cell": self.cell,
            "extrapolated": self.extrapolated,
        }


@dataclass(frozen=True)
class _Data:
    layers: dict[str, np.ndarray]
    meta: dict[str, Any]


@lru_cache(maxsize=1)
def _load() -> _Data:
    try:
        with np.load(NPZ_PATH, allow_pickle=False) as z:
            layers = {k: z[k] for k in z.files}
        meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, KeyError) as exc:
        raise SageUnavailable(f"SAGE calendars could not be read: {type(exc).__name__}") from exc
    return _Data(layers, meta)


@lru_cache(maxsize=1)
def source() -> dict[str, Any]:
    m = _load().meta
    return {"title": "Sacks et al. 2010 crop calendar (SAGE, 0.5°)", "citation": m["citation"],
            "url": m["url"], "doi": m.get("doi")}  # fmt: skip


def cell_of(lat: float, lon: float) -> tuple[int, int]:
    row = min(max(math.floor((90.0 - lat) / 0.5 + 1e-9), 0), 359)
    col = math.floor((lon + 180.0) / 0.5 + 1e-9) % 720
    return row, col


def cell_label(lat: float, lon: float) -> str:
    """SAGE cell centre as text (rounded; never the farm's own coordinates)."""
    row, col = cell_of(lat, lon)
    return f"sage_{89.75 - 0.5 * row:+.2f}_{-179.75 + 0.5 * col:+.2f}"


def _window(layers: dict[str, np.ndarray], crop: str, kind: str, rc: tuple[int, int]
            ) -> Window | None:  # fmt: skip
    s = int(layers[f"{crop}__{kind}_start"][rc])
    e = int(layers[f"{crop}__{kind}_end"][rc])
    t = int(layers[f"{crop}__{kind}"][rc])
    if s <= 0 or e <= 0:
        return None
    return Window(mm_dd(min(s, 365)), mm_dd(min(e, 365)), mm_dd(min(t, 365)) if t > 0 else None)


def calendars_at(lat: float, lon: float) -> tuple[list[CropCalendar], list[str]]:
    """``(calendars, gaps)`` for the SAGE cell holding the point. Deterministic crop order."""
    data = _load()
    rc = cell_of(lat, lon)
    label = cell_label(lat, lon)
    out: list[CropCalendar] = []
    gaps: list[str] = []
    for crop, m in data.meta["crops"].items():
        plant = _window(data.layers, crop, "plant", rc)
        if plant is None:
            continue
        extrap = bool(int(data.layers[f"{crop}__extrapolated"][rc]))
        if extrap:
            gaps.append(f"{m['name']}: SAGE's calendar for this cell is extrapolated from "
                        "neighbouring reports.")  # fmt: skip
        out.append(CropCalendar(crop, m["name"], plant, _window(data.layers, crop, "harvest", rc),
                                label, m.get("note", ""), extrap))  # fmt: skip
    return out, gaps
