"""The Union County requests whose output must not change when more locations are added.

``python -m tests.api.union_golden_requests`` prints the golden hashes; the values frozen in
``golden_union.json`` were taken at commit d7d3367 (before per-location snapshots).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

REQUESTS: dict[str, tuple[str, str, dict[str, Any] | None]] = {
    "compare_rotations": ("post", "/v1/plans/compare", {
        "rotation_ids": ["current_practice", "winter_cover", "add_grain_crop"]}),
    "compare_all_plans": ("post", "/v1/plans/compare", {
        "plan_ids": ["corn_soy__no_cover", "soy_corn__no_cover", "corn_soy__rye",
                     "soy_corn__rye", "corn_soy__wheat_dc"]}),
    "replay_2008": ("get", "/v1/seasons/2008/replay?plan=corn_soy__rye", None),
    "sensitivity": ("post", "/v1/plans/sensitivity", {"plan_id": "corn_soy__rye"}),
    "years": ("get", "/v1/years?plan=corn_soy__rye", None),
    "calendar": ("post", "/v1/plans/calendar", {
        "plan_id": "corn_soy__rye", "previous_plan_id": "corn_soy__no_cover", "year": 2025,
        "scenarios": True}),
    "note": ("post", "/v1/plans/note", {
        "plan_id": "corn_soy__rye", "alternative_id": "corn_soy__no_cover", "year": 2025,
        "as_of": "2025-09-01"}),
}


#: Keys added after d7d3367 (per-location snapshots). Everything else must be unchanged.
ADDED_TOP = ("weather_location", "readings_context")  # S5 adds context, never weather inputs
ADDED_THRESHOLDS = ("location_id", "location_name", "baseline")
ADDED_PLAN = ("region_note", "dates_assumed_for_region")


#: Keys added by A2 (location-generic analysis), stripped wherever they sit.
A2_PLAN = ("hemisphere", "coverage", "catalog")
A2_TOP = ("hemisphere", "catalog", "season_label")  # replay / sensitivity
A2_THRESHOLD = ("location", "origin")


def _strip_a2(body: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in body.items() if k not in A2_TOP}
    for block in ("winter", "spring"):
        if isinstance(out.get(block), dict):
            out[block] = {k: v for k, v in out[block].items() if k != "season_label"}
    th = out.get("thresholds")
    if isinstance(th, dict):
        th = dict(th)
        if isinstance(th.get("heavy_rain"), dict):
            th["heavy_rain"] = {k: v for k, v in th["heavy_rain"].items() if k not in A2_THRESHOLD}
        if isinstance(th.get("dry_spring"), dict):
            th["dry_spring"] = {md: {k: v for k, v in t.items() if k not in A2_THRESHOLD}
                                for md, t in th["dry_spring"].items()}  # fmt: skip
        out["thresholds"] = th
    if isinstance(out.get("plans"), list):
        plans = []
        for p in out["plans"]:
            if isinstance(p, dict):
                p = {k: v for k, v in p.items() if k not in A2_PLAN}
                if isinstance(p.get("other_checks"), list):  # P2: rule lines carry `origin`
                    p["other_checks"] = [{k: v for k, v in r.items() if k != "origin"}
                                         for r in p["other_checks"]]  # fmt: skip
                for block in ("winter", "spring"):
                    if isinstance(p.get(block), dict):
                        p[block] = {k: v for k, v in p[block].items() if k != "season_label"}
                dc = p.get("double_crop")
                we = dc.get("winter_exposure") if isinstance(dc, dict) else None
                if isinstance(we, dict) and isinstance(we.get("heavy_rain_threshold"), dict):
                    t = {k: v for k, v in we["heavy_rain_threshold"].items()
                         if k not in A2_THRESHOLD}  # fmt: skip
                    p["double_crop"] = {**dc, "winter_exposure": {**we, "heavy_rain_threshold": t}}
            plans.append(p)
        out["plans"] = plans
    return out


#: Keys B2 added to every rule ``source`` block (catalog v3), stripped wherever they sit.
B2_SOURCE = ("evidence_quote", "limitations")


def _strip_b2(x: Any) -> Any:
    if isinstance(x, dict):
        return {k: (_strip_b2({sk: sv for sk, sv in v.items() if sk not in B2_SOURCE})
                    if k == "source" and isinstance(v, dict) else _strip_b2(v))
                for k, v in x.items()}  # fmt: skip
    if isinstance(x, list):
        return [_strip_b2(v) for v in x]
    return x


def strip_additions(body: Any) -> Any:
    """``body`` without the keys that did not exist before per-location snapshots."""
    if not isinstance(body, dict):
        return body
    body = _strip_a2(_strip_b2(body))
    out = {k: v for k, v in body.items() if k not in ADDED_TOP}
    if isinstance(out.get("thresholds"), dict):
        out["thresholds"] = {k: v for k, v in out["thresholds"].items()
                             if k not in ADDED_THRESHOLDS}  # fmt: skip
    if isinstance(out.get("plans"), list):
        out["plans"] = [
            {k: v for k, v in p.items() if k not in ADDED_PLAN} if isinstance(p, dict) else p
            for p in out["plans"]
        ]
    return out


def canonical(body: Any, drop: frozenset[str] = frozenset()) -> str:
    def clean(x: Any) -> Any:
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items() if k not in drop and k != "request_id"}
        if isinstance(x, list):
            return [clean(v) for v in x]
        return x

    return json.dumps(clean(body), sort_keys=True, separators=(",", ":"))


def digest(body: Any, drop: frozenset[str] = frozenset()) -> str:
    return hashlib.sha256(canonical(body, drop).encode()).hexdigest()


def run(client: Any, drop: frozenset[str] = frozenset()) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, (method, url, body) in REQUESTS.items():
        r = client.get(url) if method == "get" else client.post(url, json=body)
        assert r.status_code == 200, (name, r.status_code, r.text[:200])
        out[name] = digest(strip_additions(r.json()), drop)
    return out


if __name__ == "__main__":
    from fastapi.testclient import TestClient

    from acre.api.app import create_app

    print(json.dumps(run(TestClient(create_app())), indent=2, sort_keys=True))
