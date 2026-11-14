"""A3: farm and field batch analysis. Synthetic fixture polygons; POWER mocked."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fieldshift.farms.geometry import GeometryError, parse_field
from fieldshift.weather import ondemand
from tests.compare.test_global_analysis import PLAN as PERG_PLAN
from tests.weather.test_weather_ondemand import FakePower

POLY = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "farms" / "polygons.json")
                  .read_text())["polygons"]  # fmt: skip
NC_PLAN = {
    "plan_id": "nc_rye", "previous_crop_id": "field_corn", "next_crop_id": "soybean",
    "prev_harvest": "10-15", "next_plant": "05-12",
    "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "10-25", "terminate": "04-20"},
}  # fmt: skip


def _field(fid: str, poly: str, plan: dict, name: str | None = None) -> dict:
    return {"field_id": fid, "name": name or fid, "geometry": POLY[poly]["geometry"],
            "plan": {**plan, "plan_id": f"{fid}_plan"}}  # fmt: skip


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    monkeypatch.setenv(ondemand.CACHE_ENV, str(tmp_path / "cache"))
    monkeypatch.delenv("FIELDSHIFT_OFFLINE", raising=False)
    ondemand.reset_jobs()
    ondemand.set_fetch(FakePower())
    yield
    ondemand.set_fetch(None)
    ondemand.reset_jobs()


@pytest.fixture
def client() -> TestClient:
    from fieldshift.api.app import create_app

    return TestClient(create_app())


def _analyze(client, fields, **options):
    r = client.post("/v1/farms/analyze", json={"farm": {"farm_id": "f1", "fields": fields},
                                               "options": {"include_capabilities": False,
                                                           "wait_s": 30, **options}})  # fmt: skip
    return r


@pytest.mark.parametrize("name", [k for k, v in POLY.items() if v["valid"]])
def test_area_matches_the_turf_fixture(name):
    shape = parse_field(POLY[name]["geometry"])
    assert abs(shape.area_ha / POLY[name]["area_ha"] - 1) < 0.005


def test_bowtie_is_rejected():
    with pytest.raises(GeometryError) as e:
        parse_field(POLY["bowtie"]["geometry"])
    assert e.value.code == "self_intersection"


def test_three_fields_in_two_cells_give_two_groups(client):
    r = _analyze(client, [_field("a", "pergamino_square", PERG_PLAN),
                          _field("b", "pergamino_l", PERG_PLAN),
                          _field("c", "pergamino_east", PERG_PLAN)])  # fmt: skip
    assert r.status_code == 200, r.text
    body = r.json()
    groups = {g["cell_id"]: g for g in body["weather_cells"]}
    assert len(groups) == 2
    shared = groups["cell_-34.000_-60.625"]
    assert shared["field_ids"] == ["a", "b"] and "share one NASA weather series" in shared["note"]
    assert groups["cell_-34.000_-60.000"]["field_ids"] == ["c"]
    assert [f["job_status"] for f in body["fields"]] == ["ready"] * 3
    assert all(f["result"]["status"] == "complete" and f["result"]["hemisphere"] == "south"
               for f in body["fields"])  # fmt: skip
    assert set(body["totals"]) == {"area_ha", "area_ac"}
    expected = sum(POLY[p]["area_ha"] for p in ("pergamino_square", "pergamino_l", "pergamino_east"))
    assert abs(body["totals"]["area_ha"] / expected - 1) < 0.005


def test_a_self_intersecting_field_is_a_typed_400_naming_it(client):
    r = _analyze(client, [_field("ok", "pergamino_square", PERG_PLAN),
                          _field("bad", "bowtie", PERG_PLAN, name="Bowtie")])  # fmt: skip
    assert r.status_code == 400
    body = r.json()
    assert body["status"] == "invalid_input"
    (i,) = body["issues"]
    assert i["field"] == "farm.fields[1].geometry" and i["code"] == "self_intersection"
    assert "Bowtie" in i["message"]


def test_nc_and_pergamino_fields_are_independent(client):
    body = _analyze(client, [_field("nc", "union_parcels", NC_PLAN),
                             _field("ar", "pergamino_square", PERG_PLAN)]).json()  # fmt: skip
    nc, ar = body["fields"]
    assert nc["scope"] == "nc" and ar["scope"] == "global"
    assert nc["result"]["hemisphere"] == "north" and ar["result"]["hemisphere"] == "south"
    assert nc["result"]["winter"]["season_label"] == "Winter"
    assert ar["result"]["winter"]["season_label"].startswith("Off-season")
    assert nc["snapshot_hash"] != ar["snapshot_hash"]
    assert len(body["weather_cells"]) == 2
    assert set(body["totals"]) == {"area_ha", "area_ac"}  # no cross-field metric
    assert body["meta"]["snapshot_hash"] is None  # a farm can span snapshots
    # NC results carry NC rules; the Pergamino field never does
    from tests.compare.test_global_analysis import NC_RULE_IDS, _strings

    assert _strings(nc["result"]) & NC_RULE_IDS
    assert not (_strings(ar["result"]) & NC_RULE_IDS)


def test_pending_weather_gives_pending_field_and_no_result(client):
    gate = threading.Event()
    ondemand.set_fetch(FakePower(gate=gate))
    body = _analyze(client, [_field("a", "pergamino_square", PERG_PLAN)], wait_s=0).json()
    (f,) = body["fields"]
    assert f["job_status"] == "pending" and f["result"] is None and f["status"] == "unknown"
    assert f["poll"] == "/v1/weather/cell_-34.000_-60.625"
    assert body["weather_cells"][0]["job_status"] == "pending"
    gate.set()
    ondemand._JOBS["cell_-34.000_-60.625"].future.result(15)
    again = _analyze(client, [_field("a", "pergamino_square", PERG_PLAN)]).json()
    assert again["fields"][0]["job_status"] == "ready" and again["fields"][0]["result"]


def test_offline_unprepared_field_is_unavailable(client, monkeypatch):
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")
    body = _analyze(client, [_field("a", "pergamino_square", PERG_PLAN)]).json()
    (f,) = body["fields"]
    assert f["job_status"] == "failed" and f["status"] == "unavailable"
    assert f["reason"] == "offline_no_snapshot" and f["reason_text"]
    assert body["status"] == "unavailable"


def test_geometry_is_never_echoed_and_centroid_is_rounded(client):
    r = _analyze(client, [_field("a", "pergamino_l", PERG_PLAN)])
    assert "coordinates" not in r.text and "geometry" not in r.text
    c = r.json()["fields"][0]["centroid"]
    assert c == {"latitude": round(c["latitude"], 2), "longitude": round(c["longitude"], 2)}
    assert "-60.594" not in r.text and "-33.915" not in r.text  # vertices


def test_logs_carry_no_coordinates(client, caplog):
    with caplog.at_level(logging.DEBUG):
        _analyze(client, [_field("a", "pergamino_l", PERG_PLAN),
                          _field("bad", "bowtie", PERG_PLAN)])  # fmt: skip
        _analyze(client, [_field("a", "pergamino_l", PERG_PLAN)])
    for token in ("-60.594", "-33.915", "-33.905", "-60.585", "-33.91", "-60.6"):
        assert token not in caplog.text


def test_field_goals_can_carry_a_recommendation(client, monkeypatch):
    import fieldshift.compare.recommend as rec

    monkeypatch.setattr(rec, "generate", lambda ctx, loc, fc, g: rec.preset_candidates(ctx, g))
    f = _field("nc", "union_parcels", NC_PLAN)
    f["goals"] = {"priorities": {"soil_cover": 3}}
    body = _analyze(client, [f], recommend=True).json()
    rec = body["fields"][0]["recommendation"]
    assert rec["method"]["shortlist"] == "pareto_non_dominated"
    assert "winter_cover" in [c["candidate_id"] for c in rec["shortlist"]]


# --------------------------------------------------------------------------- review fixes (A3.md)

SQ = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]  # synthetic shapes near null island


def _poly(*rings):
    return {"type": "Polygon", "coordinates": [list(r) for r in rings]}


@pytest.mark.parametrize("geom,code", [
    (_poly(SQ, [[3, 1], [5, 1], [5, 2], [3, 2], [3, 1]]), "hole_outside"),  # crosses the edge
    (_poly([[0, 0], [4, 0], [4, 4], [2, 1], [0, 4], [0, 0]],  # concave notch
           [[1.5, 2], [2.5, 2], [2.5, 3], [1.5, 3], [1.5, 2]]), "hole_outside"),
    (_poly(SQ, [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
           [[2, 2], [2.5, 2], [2.5, 2.5], [2, 2.5], [2, 2]]), "holes_overlap"),  # nested
    ({"type": "MultiPolygon", "coordinates": [[SQ], [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]]]},
     "parts_overlap"),
    ({"type": "MultiPolygon", "coordinates": [[SQ], [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]]]},
     "parts_overlap"),  # one part inside the other
])  # fmt: skip
def test_bad_holes_and_overlapping_parts_are_rejected(geom, code):
    with pytest.raises(GeometryError) as e:
        parse_field(geom)
    assert e.value.code == code


def test_separate_parcels_and_a_clean_hole_are_fine():
    multi = {"type": "MultiPolygon", "coordinates": [[SQ], [[[5, 0], [6, 0], [6, 1], [5, 1], [5, 0]]]]}
    holed = _poly(SQ, [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]])
    assert parse_field(multi).area_ha > parse_field(_poly(SQ)).area_ha
    assert parse_field(holed).area_ha < parse_field(_poly(SQ)).area_ha


def test_validation_errors_do_not_echo_coordinates(client):
    f = _field("a", "pergamino_square", PERG_PLAN)
    f["goals"] = {"priorities": {"-33.8812,-60.5731": 3}}
    f["plan"]["lat_-33.8812"] = -60.5731
    r = client.post("/v1/farms/analyze", json={"farm": {"fields": [f]}})
    assert r.status_code == 400
    assert "33.88" not in r.text and "60.57" not in r.text


def test_field_and_group_weather_state_agree(client):
    gate = threading.Event()
    ondemand.set_fetch(FakePower(gate=gate))
    ondemand.prepare(ondemand.Cell.parse("cell_-34.000_-60.625"))  # a fetch is running
    real_choose = __import__("fieldshift.compare.locations", fromlist=["choose"]).choose

    def finish_then_choose(*a, **k):  # the fetch lands while the batch is being processed
        gate.set()
        ondemand._JOBS["cell_-34.000_-60.625"].future.result(15)
        return real_choose(*a, **k)

    import fieldshift.farms.analyze as fa

    fa.places.choose = finish_then_choose
    try:
        body = _analyze(client, [_field("a", "pergamino_square", PERG_PLAN)], wait_s=0,
                        prepare_weather=False).json()  # fmt: skip
    finally:
        fa.places.choose = real_choose
        gate.set()
    (f,), (g,) = body["fields"], body["weather_cells"]
    assert f["job_status"] == g["job_status"]
    assert (f["snapshot_hash"] is None) == (g["snapshot_hash"] is None)


# --------------------------------------------------------------------------- review r2 fixes (A3-r2.md)


def test_identifier_shaped_client_keys_are_not_echoed(client):
    f = _field("a", "pergamino_square", PERG_PLAN)
    f["plan"]["latitude33Nlongitude60W"] = 1
    f["goals"] = {"priorities": {"lat33S": 3}}
    r = client.post("/v1/farms/analyze", json={"farm": {"fields": [f]}})
    assert r.status_code == 400
    assert "latitude33N" not in r.text and "lat33S" not in r.text
    assert any(i["field"].endswith("<key>") for i in r.json()["issues"])


def test_an_island_inside_a_hole_is_a_valid_part():
    outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]
    island = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    shape = parse_field({"type": "MultiPolygon", "coordinates": [[outer, hole], [island]]})
    ring = parse_field({"type": "Polygon", "coordinates": [outer, hole]})
    assert shape.area_ha > ring.area_ha


def test_one_snapshot_per_cell_even_if_a_refresh_lands_mid_batch(client, monkeypatch):
    real = ondemand._stored
    calls = {"n": 0}
    first = {}

    def flipping(cell):  # every later read sees a "refreshed" hash
        calls["n"] += 1
        s = real(cell)
        if s is None:
            return None
        if cell.cell_id not in first:
            first[cell.cell_id] = s
            return s
        return ondemand.Stored(s.source, s.directory, "f" * 64, s.retrieved_at)

    _analyze(client, [_field("w", "pergamino_square", PERG_PLAN)])  # prepare the cell first
    monkeypatch.setattr(ondemand, "_stored", flipping)
    body = _analyze(client, [_field("a", "pergamino_square", PERG_PLAN),
                             _field("b", "pergamino_l", PERG_PLAN)]).json()  # fmt: skip
    hashes = {f["snapshot_hash"] for f in body["fields"]} | {body["weather_cells"][0]["snapshot_hash"]}
    assert len(hashes) == 1 and "f" * 64 not in hashes
