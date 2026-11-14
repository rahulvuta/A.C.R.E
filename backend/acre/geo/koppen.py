"""Köppen-Geiger climate class at a point, from a bundled raster.

Source: Beck et al. (2023), Köppen-Geiger 1991-2020, CC BY 4.0 (see ``data/geo/koppen_meta.json``).
The committed file is the dataset's 0.1° map (about 11 km) stored as an ``.npz`` of class codes.
The resolution is returned with every lookup: a farm near a climate boundary can be in a
neighbouring class.

Class 0 is water. A point is **on land** unless its own cell and all eight neighbours are water,
because a farm on a coast can fall in a cell the map calls ocean. The class returned for such a
coastal point is the nearest land neighbour's and ``coastal_neighbour`` is true.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from acre.geo.config import GEO_DATA_DIR

RASTER_PATH = GEO_DATA_DIR / "koppen_1991_2020_0p1.npz"
META_PATH = GEO_DATA_DIR / "koppen_meta.json"

#: Beck et al. legend: raster value -> (class, plain label).
LEGEND: dict[int, tuple[str, str]] = {
    1: ("Af", "Tropical rainforest"), 2: ("Am", "Tropical monsoon"),
    3: ("Aw", "Tropical savanna"), 4: ("BWh", "Hot desert"), 5: ("BWk", "Cold desert"),
    6: ("BSh", "Hot semi-arid"), 7: ("BSk", "Cold semi-arid"),
    8: ("Csa", "Mediterranean, hot summer"), 9: ("Csb", "Mediterranean, warm summer"),
    10: ("Csc", "Mediterranean, cold summer"), 11: ("Cwa", "Humid subtropical, dry winter"),
    12: ("Cwb", "Subtropical highland, dry winter"), 13: ("Cwc", "Cold subtropical, dry winter"),
    14: ("Cfa", "Humid subtropical"), 15: ("Cfb", "Oceanic"), 16: ("Cfc", "Subpolar oceanic"),
    17: ("Dsa", "Continental, dry hot summer"), 18: ("Dsb", "Continental, dry warm summer"),
    19: ("Dsc", "Subarctic, dry summer"), 20: ("Dsd", "Subarctic, dry summer, very cold winter"),
    21: ("Dwa", "Continental, dry winter, hot summer"),
    22: ("Dwb", "Continental, dry winter, warm summer"),
    23: ("Dwc", "Subarctic, dry winter"), 24: ("Dwd", "Subarctic, dry winter, very cold winter"),
    25: ("Dfa", "Humid continental, hot summer"), 26: ("Dfb", "Humid continental, warm summer"),
    27: ("Dfc", "Subarctic"), 28: ("Dfd", "Subarctic, very cold winter"),
    29: ("ET", "Tundra"), 30: ("EF", "Ice cap"),
}  # fmt: skip
LABELS = {code: label for code, label in LEGEND.values()}


class KoppenUnavailable(RuntimeError):
    """The bundled raster is missing or unreadable."""


@dataclass(frozen=True)
class Climate:
    on_land: bool
    koppen: str | None
    label: str | None
    resolution_km: float
    coastal_neighbour: bool
    source: str
    origin: str = "dataset_estimate"

    def as_dict(self) -> dict[str, Any]:
        return {
            "koppen": self.koppen,
            "label": self.label,
            "resolution_km": self.resolution_km,
            "source": self.source,
            "origin": self.origin,
            "coastal_neighbour": self.coastal_neighbour,
        }


@dataclass(frozen=True)
class _Raster:
    classes: np.ndarray
    step: float
    meta: dict[str, Any]


_EPS = 1e-9


@lru_cache(maxsize=1)
def _load(raster_path: str = str(RASTER_PATH), meta_path: str = str(META_PATH)) -> _Raster:
    try:
        with np.load(Path(raster_path), allow_pickle=False) as z:
            classes = z["classes"]
        meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
        step = float(meta["resolution_deg"])
    except (OSError, ValueError, KeyError) as exc:
        raise KoppenUnavailable(f"Köppen raster could not be read: {type(exc).__name__}") from exc
    if classes.ndim != 2 or classes.dtype != np.uint8:
        raise KoppenUnavailable("Köppen raster has an unexpected shape or type")
    return _Raster(classes, step, meta)


def source_meta() -> dict[str, Any]:
    return dict(_load().meta)


def resolution_km(lat: float, step_deg: float) -> float:
    """Approximate east-west cell size at this latitude (the larger of the two directions)."""
    return round(max(111.2 * step_deg, 111.2 * step_deg * math.cos(math.radians(lat))), 1)


def _cell(r: _Raster, lat: float, lon: float) -> tuple[int, int]:
    rows, cols = r.classes.shape
    # the epsilon keeps grid-line points (59.7, -179.9, ...) on the cell they belong to
    row = min(max(math.floor((90.0 - lat) / r.step + _EPS), 0), rows - 1)
    col = math.floor((lon + 180.0) / r.step + _EPS) % cols
    return row, col


def lookup(lat: float, lon: float) -> Climate:
    """Climate class and land check at a point. ``lat``/``lon`` must already be valid."""
    r = _load()
    rows, cols = r.classes.shape
    row, col = _cell(r, lat, lon)
    code = int(r.classes[row, col])
    coastal = False
    if code == 0:
        near = [
            int(r.classes[min(max(row + dr, 0), rows - 1), (col + dc) % cols])
            for dr in (-1, 0, 1)
            for dc in (-1, 0, 1)
        ]
        land = [c for c in near if c != 0]
        if land:
            code = max(set(land), key=land.count)
            coastal = True
    source = str(r.meta.get("citation", "Beck et al. 2023, Koppen-Geiger 1991-2020"))
    res = resolution_km(lat, r.step)
    if code == 0 or code not in LEGEND:
        return Climate(False, None, None, res, False, source)
    name, label = LEGEND[code]
    return Climate(True, name, label, res, coastal, source)
