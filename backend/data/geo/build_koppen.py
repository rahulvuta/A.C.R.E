"""One-off preprocessing for ``koppen_1991_2020_0p1.npz`` (not imported by the app).

Input: ``1991_2020/koppen_geiger_0p1.tif`` from Beck et al. (2023), Köppen-Geiger maps,
https://figshare.com/articles/dataset/High-resolution_1_km_K_ppen-Geiger_maps_for_1901_2099_based_on_constrained_CMIP6_projections/21789074
(file ``koppen_geiger_tif.zip``, CC BY 4.0). Needs ``tifffile`` and ``imagecodecs`` (build time only).

    python build_koppen.py path/to/koppen_geiger_0p1.tif path/to/koppen_geiger_tif.zip.md5-or-note

The raster is a 1800 x 3600 array of class codes (0 = water), 0.1 degree cells, row 0 at 90N and
column 0 at 180W. It is stored unchanged apart from compression.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import tifffile

HERE = Path(__file__).resolve().parent


def main(tif: str) -> None:
    raw = Path(tif).read_bytes()
    with tifffile.TiffFile(tif) as t:
        page = t.pages[0]
        classes = page.asarray()
        scale = page.tags["ModelPixelScaleTag"].value
        tie = page.tags["ModelTiepointTag"].value
    assert classes.shape == (1800, 3600) and classes.dtype == np.uint8
    assert scale[0] == scale[1] == 0.1 and tie[3] == -180.0 and tie[4] == 90.0
    np.savez_compressed(HERE / "koppen_1991_2020_0p1.npz", classes=classes)
    meta = {
        "dataset": "Koppen-Geiger climate classification, 1991-2020 (present day)",
        "citation": "Beck et al. 2023, Koppen-Geiger 1991-2020",
        "paper": "Beck, H.E., McVicar, T.R., Vergopolan, N. et al. High-resolution (1 km) "
        "Koppen-Geiger maps for 1901-2099 based on constrained CMIP6 projections. "
        "Scientific Data 10, 724 (2023). https://doi.org/10.1038/s41597-023-02549-6",
        "data_doi": "10.6084/m9.figshare.21789074.v2",
        "license": "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
        "source_file": "1991_2020/koppen_geiger_0p1.tif in koppen_geiger_tif.zip",
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "resolution_deg": 0.1,
        "approx_resolution_km": 11,
        "grid": {"rows": 1800, "cols": 3600, "north_edge": 90.0, "west_edge": -180.0},
        "water_value": 0,
        "note": "Stored unchanged (0.1 degree map from the dataset; no resampling by us).",
    }
    (HERE / "koppen_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1])
