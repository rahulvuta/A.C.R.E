import json

import pytest

from acre.geo import koppen


def test_known_points():
    for lat, lon, code in [
        (34.98, -80.55, "Cfa"), (-33.89, -60.57, "Cfa"), (48.85, 2.35, "Cfb"),
        (-3.1, -60.0, "Af"), (23.0, 12.0, "BWh"),
    ]:  # fmt: skip
        c = koppen.lookup(lat, lon)
        assert c.on_land and c.koppen == code, (lat, lon, c)
        assert c.origin == "dataset_estimate" and c.resolution_km == pytest.approx(11.1, abs=0.1)
        assert "Beck" in c.source


@pytest.mark.parametrize("lat,lon", [(0.0, -30.0), (28.0, -90.0), (-45.0, -140.0), (30.0, 170.0)])
def test_open_water_is_not_land(lat, lon):
    c = koppen.lookup(lat, lon)
    assert not c.on_land and c.koppen is None and c.label is None


def test_a_coastal_cell_the_map_calls_ocean_still_gets_its_land_neighbour():
    r = koppen._load()
    # find a water cell with at least one land neighbour, then look it up
    rows, cols = r.classes.shape
    found = None
    for row in range(600, 700):
        for col in range(600, 700):
            if r.classes[row, col] == 0 and r.classes[row, col + 1] != 0:
                found = (90.0 - (row + 0.5) * r.step, -180.0 + (col + 0.5) * r.step)
                break
        if found:
            break
    assert found is not None
    c = koppen.lookup(*found)
    assert c.on_land and c.coastal_neighbour and c.koppen


def test_edges_do_not_crash():
    for lat, lon in [(90.0, 180.0), (-90.0, -180.0), (0.0, 180.0), (90.0, -180.0)]:
        koppen.lookup(lat, lon)


def test_legend_matches_the_dataset_legend_and_meta_names_the_licence():
    assert (
        len(koppen.LEGEND) == 30 and koppen.LEGEND[14][0] == "Cfa" and koppen.LEGEND[30][0] == "EF"
    )
    meta = json.loads(koppen.META_PATH.read_text())
    assert "CC BY 4.0" in meta["license"] and meta["resolution_deg"] == 0.1
    assert koppen.RASTER_PATH.stat().st_size < 5_000_000


def test_a_missing_raster_is_a_typed_error(tmp_path):
    with pytest.raises(koppen.KoppenUnavailable):
        koppen._load.__wrapped__(str(tmp_path / "none.npz"), str(tmp_path / "none.json"))


def test_grid_lines_use_the_cell_they_belong_to():
    r = koppen._load()
    assert koppen._cell(r, 59.7, 0.0)[0] == 303  # (90 - 59.7) / 0.1 is 302.99999999999994 in floats
    assert koppen._cell(r, 0.0, -179.9)[1] == 1
    assert koppen._cell(r, 90.0, -180.0) == (0, 0)
    assert koppen._cell(r, -90.0, 180.0) == (1799, 0)  # 180E wraps to the first column
    assert koppen._cell(r, 0.05, 0.05) == (899, 1800)
