"""Freeze the API contract: ``docs/api/openapi.json`` plus real example responses.

    python -m acre.api.contract          # regenerate (offline; reads only the snapshot)
    python -m acre.api.contract --check  # exit 1 if the committed files are stale

Examples are generated from the real Union County sample by calling the app with the network
disabled (``ACRE_OFFLINE=1``). Only ``meta.request_id`` is replaced (``req_example``) so
the files are stable. ``tests/api/test_api_contract.py`` validates every example against the
frozen schema and fails when the committed files drift from the code.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
API_DIR = ROOT / "docs" / "api"
EXAMPLES_DIR = API_DIR / "examples"
REQUESTS_DIR = EXAMPLES_DIR / "requests"
OPENAPI_PATH = API_DIR / "openapi.json"


@dataclass(frozen=True)
class Example:
    name: str
    method: str
    path: str  # OpenAPI path template
    url: str  # concrete URL (with query)
    body: dict[str, Any] | None
    status: int


def example_specs() -> list[Example]:
    bad_plan = _sample_plan("corn_soy__rye")
    bad_plan["winter"]["terminate"] = "05-20"  # terminates after planting
    return [
        Example("compare", "post", "/v1/plans/compare", "/v1/plans/compare",
                {"rotation_ids": ["current_practice", "winter_cover", "add_grain_crop"]}, 200),
        Example("compare_johnston", "post", "/v1/plans/compare", "/v1/plans/compare",
                {"plan_ids": ["corn_soy__no_cover", "corn_soy__rye"],
                 "location_id": "johnston"}, 200),
        Example("compare_no_weather_snapshot", "post", "/v1/plans/compare", "/v1/plans/compare",
                {"plan_ids": ["corn_soy__rye"],
                 "location": {"latitude": 35.78, "longitude": -78.64}}, 200),
        Example("compare_outside_nc_offline", "post", "/v1/plans/compare", "/v1/plans/compare",
                {"plan_ids": ["corn_soy__rye"],
                 "location": {"latitude": 40.7, "longitude": -74.0}}, 200),
        Example("error_invalid_input", "post", "/v1/plans/compare", "/v1/plans/compare",
                {"plans": [bad_plan]}, 400),
        Example("calendar", "post", "/v1/plans/calendar", "/v1/plans/calendar",
                {"plan_id": "corn_soy__rye", "previous_plan_id": "corn_soy__no_cover",
                 "year": 2025, "scenarios": True}, 200),
        Example("backup", "post", "/v1/plans/backup", "/v1/plans/backup",
                {"plan_id": "corn_soy__no_cover", "fallback_id": "corn_soy__rye", "year": 2025,
                 "as_of": "2025-09-01"}, 200),
        Example("note", "post", "/v1/plans/note", "/v1/plans/note",
                {"plan_id": "corn_soy__rye", "alternative_id": "corn_soy__no_cover", "year": 2025,
                 "as_of": "2025-09-01"}, 200),
        Example("note_get", "get", "/v1/plans/{plan_id}/note",
                "/v1/plans/corn_soy__rye/note?alternative=corn_soy__no_cover&year=2025&as_of=2025-09-01",
                None, 200),
        Example("replay", "get", "/v1/seasons/{year}/replay",
                "/v1/seasons/2008/replay?plan=corn_soy__rye", None, 200),
        Example("sensitivity", "post", "/v1/plans/sensitivity", "/v1/plans/sensitivity",
                {"plan_id": "corn_soy__rye"}, 200),
        Example("years", "get", "/v1/years", "/v1/years?plan=corn_soy__rye", None, 200),
        Example("rotations", "get", "/v1/rotations", "/v1/rotations", None, 200),
        Example("health", "get", "/health", "/health", None, 200),
        *global_specs(),
        *simulator_specs(),
    ]


# --------------------------------------------------------------------------- global (A1-A3, P2)

PERG = {"latitude": -33.89, "longitude": -60.57}
PERG_PLAN = {"plan_id": "perg_soy", "previous_crop_id": "maize", "next_crop_id": "soybean",
             "prev_harvest": "04-20", "next_plant": "11-15",
             "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "05-01",
                        "terminate": "10-20"}}  # fmt: skip
NC_PLAN = {"plan_id": "nc_rye", "previous_crop_id": "field_corn", "next_crop_id": "soybean",
           "prev_harvest": "10-15", "next_plant": "05-12",
           "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "10-25",
                      "terminate": "04-20"}}  # fmt: skip
#: synthetic field boundaries (the frontend's contract fixtures), never a real farm
SQUARE = {"type": "Polygon", "coordinates": [[[-60.58, -33.88], [-60.57, -33.88], [-60.57, -33.89],
                                              [-60.58, -33.89], [-60.58, -33.88]]]}  # fmt: skip
UNION_SQ = {"type": "Polygon", "coordinates": [[[-80.56, 34.98], [-80.55, 34.98], [-80.55, 34.97],
                                                [-80.56, 34.97], [-80.56, 34.98]]]}  # fmt: skip
BOWTIE = {"type": "Polygon", "coordinates": [[[-60.58, -33.88], [-60.57, -33.89], [-60.57, -33.88],
                                              [-60.58, -33.89], [-60.58, -33.88]]]}  # fmt: skip
PENDING_POINT = {"latitude": 41.9, "longitude": -93.6}  # a cell nobody has prepared


def _farm(*fields: tuple[str, str, dict[str, Any], dict[str, Any]]) -> dict[str, Any]:
    return {"farm": {"farm_id": "example_farm", "name": "Example farm (synthetic)", "fields": [
        {"field_id": fid, "name": name, "geometry": geom, "plan": {**plan, "plan_id": f"{fid}_plan"}}
        for fid, name, geom, plan in fields]}, "options": {"include_capabilities": False}}  # fmt: skip


#: Synthetic example numbers for the simulator examples (not sourced; labelled as such).
SIM_ECON = {
    "soybean": {"price": {"value": 11.2, "unit": "USD/bu"}, "yield": {"value": 48, "unit": "bu/acre"},
                "costs": {"value": 410, "unit": "USD/acre"}},
    "field_corn": {"price": {"value": 4.5, "unit": "USD/bu"}, "yield": {"value": 170, "unit": "bu/acre"},
                   "costs": {"value": 700, "unit": "USD/acre"}},
    "cereal_rye": {"costs": {"value": 45, "unit": "USD/acre"}},
}  # fmt: skip
NC_SOY_CORN = {"plan_id": "nc_soy_corn_rye", "previous_crop_id": "soybean", "next_crop_id": "field_corn",
               "prev_harvest": "10-20", "next_plant": "04-20",
               "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "10-30",
                          "terminate": "04-01"}}  # fmt: skip


def simulator_specs() -> list[Example]:
    bare = {**NC_PLAN, "plan_id": "nc_bare", "winter": {"kind": "none"}}
    bare2 = {**NC_SOY_CORN, "plan_id": "nc_soy_corn_bare", "winter": {"kind": "none"}}
    body = {"location": {"latitude": 34.98, "longitude": -80.55},
            "field": {"field_id": "fld_example", "name": "Example field", "area_ha": 16.2,
                      "equipment": ["planter", "grain_drill", "sprayer", "combine"],
                      "readings": [{"date": "2025-04-02", "kind": "soil_moisture_pct",
                                    "value": 23.5, "depth_cm": 10}]},
            "goals": {"priorities": {"soil_cover": 2, "profit": 3}},
            "economics": {"overrides": SIM_ECON, "loss_assumptions": {"dry_spring_pct": 15}},
            "scenarios": [{"scenario_id": "current", "label": "What I do now", "is_baseline": True,
                           "rotation": [bare, bare2]},
                          {"scenario_id": "rye", "label": "Add cereal rye",
                           "rotation": [NC_PLAN, NC_SOY_CORN]}],
            "years": 10, "runs": 200, "seed": 7, "start_season": "2027"}
    no_money = {**body, "economics": {}, "field": {"area_ha": 16.2}, "years": 5, "runs": 50}
    return [
        Example("simulate_union", "post", "/v1/scenarios/simulate", "/v1/scenarios/simulate",
                body, 200),
        Example("simulate_union_no_money", "post", "/v1/scenarios/simulate",
                "/v1/scenarios/simulate", no_money, 200),
        Example("simulate_pergamino", "post", "/v1/scenarios/simulate", "/v1/scenarios/simulate",
                {"location": PERG, "years": 5, "runs": 50, "scenarios": [
                    {"scenario_id": "now", "rotation": [{**PERG_PLAN, "plan_id": "perg_bare",
                                                         "winter": {"kind": "none"}}]},
                    {"scenario_id": "rye", "rotation": [PERG_PLAN]}]}, 200),
        Example("simulate_invalid_runs", "post", "/v1/scenarios/simulate",
                "/v1/scenarios/simulate", {**no_money, "runs": 10}, 400),
        Example("vocab_priorities", "get", "/v1/vocab/priorities", "/v1/vocab/priorities", None,
                200),
    ]  # fmt: skip


def global_specs() -> list[Example]:
    pending = {"location": PENDING_POINT}
    return [
        Example("weather_prepare_union", "post", "/v1/weather/prepare", "/v1/weather/prepare",
                {"location": {"latitude": 34.98, "longitude": -80.55}}, 200),
        Example("weather_prepare_pergamino", "post", "/v1/weather/prepare", "/v1/weather/prepare",
                {"location": PERG}, 200),
        Example("weather_get_offline", "get", "/v1/weather/{cell_id}",
                "/v1/weather/cell_+42.000_-93.750", None, 200),
        Example("weather_prepare_pending", "post", "/v1/weather/prepare", "/v1/weather/prepare",
                pending, 200),
        Example("compare_pergamino", "post", "/v1/plans/compare", "/v1/plans/compare",
                {"plans": [PERG_PLAN], "location": PERG, "include_soil": False}, 200),
        Example("years_post_pergamino", "post", "/v1/years", "/v1/years",
                {"plan": PERG_PLAN, "location": PERG}, 200),
        Example("sensitivity_pergamino", "post", "/v1/plans/sensitivity", "/v1/plans/sensitivity",
                {"plan": PERG_PLAN, "location": PERG}, 200),
        Example("farm_analyze_nc_pergamino", "post", "/v1/farms/analyze", "/v1/farms/analyze",
                _farm(("fld_nc", "Union field (synthetic)", UNION_SQ, NC_PLAN),
                      ("fld_ar", "Pergamino field (synthetic)", SQUARE, PERG_PLAN)), 200),
        Example("farm_analyze_offline", "post", "/v1/farms/analyze", "/v1/farms/analyze",
                _farm(("fld_ia", "Unprepared cell (synthetic)",
                       {"type": "Polygon", "coordinates": [[[-93.61, 41.9], [-93.6, 41.9],
                                                            [-93.6, 41.89], [-93.61, 41.89],
                                                            [-93.61, 41.9]]]}, NC_PLAN)), 200),
        Example("farm_invalid_bowtie", "post", "/v1/farms/analyze", "/v1/farms/analyze",
                _farm(("fld_bad", "Bowtie", BOWTIE, PERG_PLAN)), 400),
        Example("recommend_union", "post", "/v1/plans/recommend", "/v1/plans/recommend",
                {"location_id": "union", "goals": {"priorities": {"soil_cover": 3,
                                                                  "management_simplicity": 1}}},
                200),
        Example("recommend_pergamino", "post", "/v1/plans/recommend", "/v1/plans/recommend",
                {"location": PERG, "goals": {"priorities": {"soil_cover": 3}},
                 "candidates": [
                     {"candidate_id": "rye_cover", "plans": [PERG_PLAN]},
                     {"candidate_id": "no_cover",
                      "plans": [{**PERG_PLAN, "plan_id": "perg_bare", "winter": {"kind": "none"}}]}]},
                200),
    ]  # fmt: skip


@contextmanager
def seeded_cache() -> Iterator[None]:
    """A temporary ACRE_CACHE_DIR holding the recorded Pergamino POWER response (public NASA
    data, ``tests/fixtures/power``), written without the network, with its real retrieval time so
    the examples are stable. The caller's environment is restored."""
    import tempfile

    from acre.weather import ondemand
    from acre.weather.power_client import RawFetch

    fixture = ROOT / "tests" / "fixtures" / "power" / "pergamino_cell_-34.000_-60.625.json"
    previous = os.environ.get(ondemand.CACHE_ENV)
    with tempfile.TemporaryDirectory() as tmp:
        os.environ[ondemand.CACHE_ENV] = tmp

        def recorded(*_a: Any, **_k: Any) -> RawFetch:
            return RawFetch(body=fixture.read_bytes(), url="recorded fixture " + fixture.name,
                            params={}, status_code=200, retrieved_at="2026-11-14T16:41:05Z",
                            elapsed_s=0.0)  # fmt: skip

        ondemand.reset_jobs()
        ondemand.fetch_and_store(ondemand.Cell.parse("cell_-34.000_-60.625"), recorded)
        try:
            yield
        finally:
            ondemand.reset_jobs()
            ondemand.set_fetch(None)
            if previous is None:
                os.environ.pop(ondemand.CACHE_ENV, None)
            else:
                os.environ[ondemand.CACHE_ENV] = previous


def _sample_plan(plan_id: str) -> dict[str, Any]:
    doc = json.loads((ROOT / "data" / "samples" / "union_plans.json").read_text(encoding="utf-8"))
    return next(s["plan"] for s in doc["samples"] if s["plan_id"] == plan_id)


@contextmanager
def offline() -> Iterator[None]:
    """ACRE_OFFLINE=1 for the duration only; the caller's environment is restored."""
    previous = os.environ.get("ACRE_OFFLINE")
    os.environ["ACRE_OFFLINE"] = "1"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("ACRE_OFFLINE", None)
        else:
            os.environ["ACRE_OFFLINE"] = previous


def build_openapi() -> dict[str, Any]:
    from acre.api.app import create_app

    spec = create_app().openapi()
    spec["info"]["description"] = (
        "A.C.R.E backend. Labels and values ship together; every response carries "
        "meta {plan_version, catalog_version, snapshot_hash, request_id}. Partial results keep "
        "per-metric statuses in the body; HTTP 400 is only for invalid input."
    )
    return json.loads(json.dumps(spec, sort_keys=True))


def _normalize(body: Any) -> Any:
    if isinstance(body, dict):
        meta = body.get("meta")
        if isinstance(meta, dict) and "request_id" in meta:
            meta["request_id"] = "req_example"
        if "request_id" in body:  # the flat invalid_input envelope
            body["request_id"] = "req_example"
    return body


def build_examples() -> dict[str, tuple[Example, dict[str, Any] | None, Any]]:
    with seeded_cache(), offline():
        return _build_examples()


def _build_examples() -> dict[str, tuple[Example, dict[str, Any] | None, Any]]:
    from fastapi.testclient import TestClient

    from acre.api.app import create_app

    client = TestClient(create_app())
    out: dict[str, tuple[Example, dict[str, Any] | None, Any]] = {}
    for ex in example_specs():
        if ex.name == "weather_prepare_pending":
            resp = _pending(client, ex)
        else:
            resp = client.get(ex.url) if ex.method == "get" else client.post(ex.url, json=ex.body)
        if resp.status_code != ex.status:
            raise RuntimeError(f"{ex.name}: expected {ex.status}, got {resp.status_code}")
        out[ex.name] = (ex, ex.body, _normalize(resp.json()))
    return out


def _pending(client: Any, ex: Example) -> Any:
    """A fetch that has started but not finished: a POWER stand-in that waits, network off."""
    import threading

    from acre.weather import ondemand

    gate = threading.Event()

    def waiting(*_a: Any, **_k: Any) -> Any:
        gate.wait(30)
        raise ondemand.FetchFailed("power_unreachable")

    ondemand.set_fetch(waiting)
    os.environ.pop("ACRE_OFFLINE", None)  # restored by ``offline()`` on exit
    try:
        return client.post(ex.url, json=ex.body)
    finally:
        os.environ["ACRE_OFFLINE"] = "1"
        gate.set()
        ondemand.reset_jobs()
        ondemand.set_fetch(None)


def _dump(obj: Any) -> str:
    return json.dumps(obj, indent=2, sort_keys=True) + "\n"


def render() -> dict[Path, str]:
    """Every file this module owns, as ``{path: text}``."""
    with offline():
        files: dict[Path, str] = {OPENAPI_PATH: _dump(build_openapi())}
    for name, (ex, body, resp) in build_examples().items():
        files[EXAMPLES_DIR / f"{name}.json"] = _dump(resp)
        files[REQUESTS_DIR / f"{name}.json"] = _dump(
            {"method": ex.method.upper(), "url": ex.url, "status": ex.status, "body": body}
        )
    return files


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="acre.api.contract")
    ap.add_argument("--check", action="store_true", help="fail if committed files are stale")
    args = ap.parse_args(argv)
    files = render()
    if args.check:
        stale = [str(p.relative_to(ROOT)) for p, text in files.items()
                 if not p.exists() or p.read_text(encoding="utf-8") != text]
        if stale:
            print("stale contract files (run python -m acre.api.contract):", *stale, sep="\n  ")
            return 1
        print("contract files are current")
        return 0
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    print(f"wrote {len(files)} files under {API_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
