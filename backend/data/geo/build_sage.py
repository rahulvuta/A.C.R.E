"""One-off preprocessing for ``sage_calendars_0p5.npz`` (not imported by the app).

Input: the 0.5 degree netCDF files of the SAGE Crop Calendar Dataset (Sacks et al. 2010),
https://sage.nelson.wisc.edu/data-and-models/datasets/crop-calendar-dataset/netcdf-0-5-degree/
(``<Crop>.crop.calendar.nc.gz`` = observed cells, ``<Crop>.crop.calendar.fill.nc.gz`` = cells filled by
the authors' extrapolation). Needs ``netCDF4`` (build time only).

    python build_sage.py path/to/folder_with_unzipped_nc_files

For every crop it keeps six day-of-year layers (plant start/median/end and harvest start/median/end,
rounded to whole days, 0 = no data) on the dataset's 360 x 720 grid (row 0 at 89.75N, column 0 at
179.75W) and a mask of the cells that exist only in the *filled* file (``extrapolated``).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import netCDF4
import numpy as np

HERE = Path(__file__).resolve().parent
#: SAGE file stem -> (our crop id, plain name, season note)
CROPS = {
    "Barley": ("barley", "Barley (spring)", ""),
    "Barley.Winter": ("winter_barley", "Winter barley", ""),
    "Cassava": ("cassava", "Cassava", ""),
    "Cotton": ("cotton", "Cotton", ""),
    "Groundnuts": ("groundnut", "Groundnut (peanut)", ""),
    "Maize": ("maize", "Maize (corn), main season", ""),
    "Maize.2": ("maize_second", "Maize (corn), second season", "second crop of the year"),
    "Millet": ("millet", "Millet", ""),
    "Oats": ("oats", "Oats (spring)", ""),
    "Oats.Winter": ("winter_oats", "Winter oats", ""),
    "Potatoes": ("potato", "Potato", ""),
    "Pulses": ("pulses", "Pulses", ""),
    "Rapeseed.Winter": ("winter_rapeseed", "Winter rapeseed (canola)", ""),
    "Rice": ("rice", "Rice, main season", ""),
    "Rice.2": ("rice_second", "Rice, second season", "second crop of the year"),
    "Rye.Winter": ("winter_rye", "Winter rye (grain)", ""),
    "Sorghum": ("sorghum", "Sorghum, main season", ""),
    "Sorghum.2": ("sorghum_second", "Sorghum, second season", "second crop of the year"),
    "Soybeans": ("soybean", "Soybean", ""),
    "Sugarbeets": ("sugarbeet", "Sugar beet", ""),
    "Sunflower": ("sunflower", "Sunflower", ""),
    "Sweet.Potatoes": ("sweet_potato", "Sweet potato", ""),
    "Wheat": ("spring_wheat", "Spring wheat", ""),
    "Wheat.Winter": ("winter_wheat", "Winter wheat", ""),
    "Yams": ("yam", "Yam", ""),
}
LAYERS = {
    "plant_start": "plant.start", "plant": "plant", "plant_end": "plant.end",
    "harvest_start": "harvest.start", "harvest": "harvest", "harvest_end": "harvest.end",
}  # fmt: skip


def _layer(ds: netCDF4.Dataset, name: str) -> np.ndarray:
    v = np.ma.filled(ds[name][:], np.nan).astype("float64")
    v[(v > 1e20) | (v <= 0)] = np.nan
    return v


def _find(root: Path, stem: str, kind: str) -> Path:
    """The unzipped file for a crop: ``<stem>.crop.calendar[.fill].nc`` (or ``<stem>[.fill].nc``)."""
    for name in (f"{stem}.crop.calendar{kind}.nc", f"{stem}{kind}.nc"):
        if (root / name).exists():
            return root / name
    raise FileNotFoundError(f"{stem}{kind}")


def main(folder: str) -> None:
    root = Path(folder)
    out: dict[str, np.ndarray] = {}
    meta_crops: dict[str, dict[str, str]] = {}
    for stem, (crop_id, name, note) in CROPS.items():
        obs = netCDF4.Dataset(_find(root, stem, ""))
        fill = netCDF4.Dataset(_find(root, stem, ".fill"))
        has_obs = ~np.isnan(_layer(obs, "plant"))
        extrap = np.zeros(has_obs.shape, dtype=np.uint8)
        for key, var in LAYERS.items():
            a, b = _layer(obs, var), _layer(fill, var)
            merged = np.where(np.isnan(a), b, a)
            if key == "plant":
                extrap = (~has_obs & ~np.isnan(merged)).astype(np.uint8)
            arr = np.nan_to_num(np.rint(merged), nan=0.0).astype(np.int16)
            out[f"{crop_id}__{key}"] = arr
        out[f"{crop_id}__extrapolated"] = extrap
        meta_crops[crop_id] = {"sage_file": stem, "name": name, "note": note}
    np.savez_compressed(HERE / "sage_calendars_0p5.npz", **out)
    meta = {
        "dataset": "SAGE Crop Calendar Dataset (planting and harvest dates), 0.5 degree",
        "citation": "Sacks, Deryng, Foley & Ramankutty 2010, Crop planting dates: an analysis of "
        "global patterns, Global Ecology and Biogeography 19, 607-620",
        "doi": "10.1111/j.1466-8238.2010.00551.x",
        "url": "https://sage.nelson.wisc.edu/data-and-models/datasets/crop-calendar-dataset/",
        "license_note": "SAGE: datasets may be freely downloaded; cite Sacks et al. 2010.",
        "resolution_deg": 0.5,
        "grid": {"rows": 360, "cols": 720, "north_edge": 90.0, "west_edge": -180.0},
        "layers": list(LAYERS),
        "units": "day of year (1-365); 0 = no data; an end before a start means the window "
        "crosses New Year",
        "values_are": "dataset_estimate: gridded estimates from national and sub-national "
        "reports, mostly circa 1990-2000; not a recommendation",
        "extrapolated_note": "cells marked extrapolated exist only in SAGE's filled file",
        "crops": meta_crops,
    }
    (HERE / "sage_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1])
