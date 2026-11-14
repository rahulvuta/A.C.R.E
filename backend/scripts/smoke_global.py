"""Global smoke test against a running server (A4). Standard library only.

    # 1. seed a cache with the recorded Pergamino POWER response (no network: "mocked POWER")
    python scripts/smoke_global.py seed --cache /tmp/fs-cache
    # 2. start the server offline on that cache
    FIELDSHIFT_OFFLINE=1 FIELDSHIFT_CACHE_DIR=/tmp/fs-cache \\
        python -m uvicorn fieldshift.api.app:app --port 8765
    # 3. run the checks
    python scripts/smoke_global.py run --base http://127.0.0.1:8765

``run`` walks the map-to-plan flow for the NC demo (offline, committed snapshot) and for
Pergamino (the seeded cell): geo search, reverse, capabilities, weather prepare and poll, farm
analysis, recommendation, field note and regional profile. Every response must carry ``meta``
and only the nine status words. It exits 1 on the first failed check. Coordinates used are
synthetic demo points, never a farm.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
FIXTURE = BACKEND / "tests" / "fixtures" / "power" / "pergamino_cell_-34.000_-60.625.json"
STATUS = {"complete", "partial", "unavailable", "unknown", "inapplicable", "unsupported",
          "invalid_input", "manual_check", "insufficient_data"}  # fmt: skip
UNION = {"latitude": 34.98, "longitude": -80.55}
PERG = {"latitude": -33.89, "longitude": -60.57}
SQUARE = {"type": "Polygon", "coordinates": [[[-60.58, -33.88], [-60.57, -33.88], [-60.57, -33.89],
                                              [-60.58, -33.89], [-60.58, -33.88]]]}  # fmt: skip
UNION_SQ = {"type": "Polygon", "coordinates": [[[-80.56, 34.98], [-80.55, 34.98], [-80.55, 34.97],
                                                [-80.56, 34.97], [-80.56, 34.98]]]}  # fmt: skip
NC_PLAN = {"plan_id": "smoke_nc", "previous_crop_id": "field_corn", "next_crop_id": "soybean",
           "prev_harvest": "10-15", "next_plant": "05-12",
           "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "10-25",
                      "terminate": "04-20"}}  # fmt: skip
PERG_PLAN = {"plan_id": "smoke_ar", "previous_crop_id": "maize", "next_crop_id": "soybean",
             "prev_harvest": "04-20", "next_plant": "11-15",
             "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "05-01",
                        "terminate": "10-20"}}  # fmt: skip


def seed(cache: str) -> int:
    """Write the recorded Pergamino response into ``cache`` as an A1 cell snapshot."""
    import os
    from datetime import UTC, datetime

    os.environ["FIELDSHIFT_CACHE_DIR"] = cache
    os.environ.pop("FIELDSHIFT_OFFLINE", None)
    sys.path.insert(0, str(BACKEND))
    from fieldshift.weather import ondemand
    from fieldshift.weather.power_client import RawFetch

    def recorded(lat: float, lon: float, start: str, end: str, **_: Any) -> RawFetch:
        return RawFetch(body=FIXTURE.read_bytes(), url="recorded-fixture:" + FIXTURE.name,
                        params={}, status_code=200,
                        retrieved_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        elapsed_s=0.0)  # fmt: skip

    stored = ondemand.fetch_and_store(ondemand.Cell.parse("cell_-34.000_-60.625"), recorded)
    print(f"seeded {stored.directory} ({stored.snapshot_hash[:12]})")
    return 0


class Smoke:
    def __init__(self, base: str, client: Any = None) -> None:
        self.base = base.rstrip("/")
        self.client = client  # a FastAPI TestClient for --inprocess, else real HTTP
        self.n = 0

    def call(self, method: str, path: str, body: Any = None, expect: int = 200) -> dict[str, Any]:
        if self.client is not None:
            r = self.client.request(method, path, json=body)
            return self._check(method, path, r.status_code, r.content, expect)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})  # fmt: skip
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                code, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, raw = e.code, e.read()
        return self._check(method, path, code, raw, expect)

    def _check(self, method: str, path: str, code: int, raw: bytes, expect: int) -> dict[str, Any]:
        out = json.loads(raw)
        self.check(code == expect, f"{method} {path}: HTTP {code}, expected {expect}")
        self.check("meta" in out or "request_id" in out, f"{path}: no metadata")
        self._statuses(out, path)
        return out

    def _statuses(self, obj: Any, path: str) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k == "status" and isinstance(v, str):
                    self.check(v in STATUS, f"{path}: status '{v}' is not in the vocabulary")
                self._statuses(v, path)
        elif isinstance(obj, list):
            for v in obj:
                self._statuses(v, path)

    def check(self, ok: bool, what: str) -> None:
        self.n += 1
        if not ok:
            print(f"FAIL {what}")
            raise SystemExit(1)

    def step(self, name: str) -> None:
        print(f"- {name}")


def run(base: str, inprocess: bool = False) -> int:
    client = None
    if inprocess:  # the real app, called without a socket (FastAPI TestClient)
        sys.path.insert(0, str(BACKEND))
        from fastapi.testclient import TestClient

        from fieldshift.api.app import create_app

        client = TestClient(create_app())
    s = Smoke(base, client)
    s.step("health")
    h = s.call("GET", "/health")
    s.check(h["status"] == "complete", "health status")

    for label, pt, geom, plan, region in (("NC demo", UNION, UNION_SQ, NC_PLAN, "US-NC"),
                                          ("Pergamino", PERG, SQUARE, PERG_PLAN, "AR-B")):  # fmt: skip
        q = f"lat={pt['latitude']}&lon={pt['longitude']}"
        s.step(f"{label}: search, reverse, capabilities")
        found = s.call("GET", f"/v1/geo/search?q={pt['latitude']},%20{pt['longitude']}")
        s.check(found.get("query_kind") == "coordinates", "coordinate search")
        rev = s.call("GET", f"/v1/geo/reverse?{q}")
        s.check(rev["status"] in STATUS, "reverse status")
        cap = s.call("GET", f"/v1/locations/capabilities?{q}")
        s.check("features" in cap, "capabilities features")

        s.step(f"{label}: prepare weather, then poll")
        prep = s.call("POST", "/v1/weather/prepare", {"location": pt, "wait_s": 60})
        cell = prep["cell_id"]
        for _ in range(30):
            if prep["job_status"] != "pending":
                break
            time.sleep(2)
            prep = s.call("GET", f"/v1/weather/{cell}")
        s.check(prep["job_status"] == "ready", f"{label}: weather ready ({prep.get('reason')})")
        s.check(prep["meta"]["snapshot_hash"] == prep["snapshot_hash"], "weather meta hash")

        s.step(f"{label}: farm analyze")
        farm = s.call("POST", "/v1/farms/analyze", {"farm": {"farm_id": "smoke", "fields": [
            {"field_id": "f1", "name": "Smoke field", "geometry": geom, "plan": plan}]}})  # fmt: skip
        (f,) = farm["fields"]
        s.check(f["job_status"] == "ready" and f["result"] is not None, f"{label}: field result")
        s.check(set(farm["totals"]) == {"area_ha", "area_ac"}, "area is the only total")
        s.check("coordinates" not in json.dumps(farm), "geometry not echoed")

        s.step(f"{label}: recommend")
        cands = None if region == "US-NC" else [
            {"candidate_id": "rye", "plans": [plan]},
            {"candidate_id": "bare", "plans": [{**plan, "plan_id": "bare", "winter": {"kind": "none"}}]}]  # fmt: skip
        rec = s.call("POST", "/v1/plans/recommend", {"location": pt, "candidates": cands,
                                                     "goals": {"priorities": {"soil_cover": 3}}})  # fmt: skip
        s.check(rec["status"] in ("complete", "partial") and rec["shortlist"], f"{label}: shortlist")
        s.check("score" not in json.dumps(rec).lower(), "no score")

        s.step(f"{label}: field note")
        note = s.call("POST", "/v1/plans/note", {"plan": plan, "year": 2025, "location": pt})
        if region == "US-NC":
            s.check(note.get("status") in ("complete", "partial", None), "NC note")
        else:  # B's note route is NC-only until B generalises it
            s.check(note.get("code") in ("unsupported_location", None), "non-NC note answered")

        s.step(f"{label}: regional profile")
        try:
            prof = s.call("GET", f"/v1/regions/{region}/profile", expect=200)
        except SystemExit:
            print("  (profile route missing: B2 is not in this build)")
            raise
        s.check(prof.get("region_key") == region, "profile region key")

    s.step("invalid input is a typed 400")
    s.call("POST", "/v1/weather/prepare", {"location": {"latitude": 95, "longitude": 0}}, 400)
    print(f"OK ({s.n} checks)")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="smoke_global")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("seed")
    a.add_argument("--cache", required=True)
    b = sub.add_parser("run")
    b.add_argument("--base", default="http://127.0.0.1:8765")
    b.add_argument("--inprocess", action="store_true",
                   help="call the app in this process instead of a server (same requests)")
    args = ap.parse_args(argv)
    return seed(args.cache) if args.cmd == "seed" else run(args.base, args.inprocess)


if __name__ == "__main__":
    sys.exit(main())
