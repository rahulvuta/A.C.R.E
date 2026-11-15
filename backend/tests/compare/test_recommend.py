"""P2: indicators, Pareto shortlist and explanations. Offline; POWER mocked for Pergamino."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from acre.compare.pareto import dominates, pareto
from tests.compare.test_global_analysis import PERG, PLAN, _prepare

D = {"a": "lower_better", "b": "higher_better"}


# --------------------------------------------------------------------------- dominance (synthetic)


def test_dominance_is_direction_aware():
    assert dominates({"a": 1, "b": 5}, {"a": 2, "b": 5}, D)
    assert not dominates({"a": 2, "b": 5}, {"a": 1, "b": 5}, D)
    assert not dominates({"a": 1, "b": 4}, {"a": 2, "b": 5}, D)  # a trade-off


def test_ties_dominate_neither_way_and_both_stay():
    res = pareto({"x": {"a": 1, "b": 5}, "y": {"a": 1, "b": 5}}, D, {"a": 1, "b": 1})
    assert sorted(res.shortlist) == ["x", "y"] and res.dominated == {}
    assert res.ranks["x"] == res.ranks["y"] == {"a": 1, "b": 1}


def test_missing_indicator_is_not_comparable_not_zero():
    vecs = {"x": {"a": 1, "b": 5}, "y": {"a": None, "b": 9}, "z": {"a": 3, "b": 1}}
    res = pareto(vecs, D, {"a": 1, "b": 1})
    assert res.not_comparable == {"y": ["a"]}
    assert res.shortlist == ["x"] and res.dominated == {"z": ["x"]}


def test_single_candidate_is_its_own_shortlist():
    res = pareto({"only": {"a": 7, "b": 0}}, D, {"a": 3})
    assert res.shortlist == ["only"] and res.ranks["only"] == {"a": 1, "b": 1}


def test_weights_reorder_the_shortlist_only():
    vecs = {"x": {"a": 1, "b": 1}, "y": {"a": 2, "b": 9}}  # a trade-off: both stay
    a_first = pareto(vecs, D, {"a": 3, "b": 1})
    b_first = pareto(vecs, D, {"a": 1, "b": 3})
    assert a_first.shortlist == ["x", "y"] and b_first.shortlist == ["y", "x"]


# --------------------------------------------------------------------------- API (Union County)


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    """The P1 stub (NC presets) is pinned here: these tests check P2 on known candidates.
    B's generator (P1) is tested in B's own tests."""
    import acre.api.recommend_routes as rr
    import acre.compare.recommend as rec

    def stub(ctx, location, field_ctx, goals):
        return rec.preset_candidates(ctx, goals)

    monkeypatch.setattr(rec, "generate", stub)
    monkeypatch.setattr(rr, "generate", stub)
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    from acre.api.app import create_app

    return TestClient(create_app())


def _rec(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    r = client.post("/v1/plans/recommend", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _keys(obj: Any) -> set[str]:
    if isinstance(obj, dict):
        return set(obj) | set().union(*(_keys(v) for v in obj.values())) if obj else set()
    if isinstance(obj, list):
        return set().union(*(_keys(v) for v in obj)) if obj else set()
    return set()


def _all_cards(body):
    return body["shortlist"] + body["dominated"] + body["not_comparable"]


def test_union_soil_cover_shortlists_the_rye_plan_with_real_numbers(client):
    body = _rec(client, {"goals": {"priorities": {"soil_cover": 3}}})
    assert body["status"] == "complete"
    assert body["method"]["shortlist"] == "pareto_non_dominated"
    assert body["method"]["note"].startswith("Not universally optimal")
    ids = [c["candidate_id"] for c in body["shortlist"]]
    assert "winter_cover" in ids
    rye = next(c for c in body["shortlist"] if c["candidate_id"] == "winter_cover")
    assert "rain_on_bare_soil_mm" in rye["wins"]
    why = next(w for w in rye["why"] if w["indicator"] == "rain_on_bare_soil_mm")
    # the real numbers from compare: mean over the two rye legs of their median
    cmp = client.post("/v1/plans/compare", json={"rotation_ids": ["winter_cover"],
                                                 "include_soil": False}).json()  # fmt: skip
    legs = [p["winter"]["per_season_median"]["rain_mm_outside_cover"] for p in cmp["plans"]]
    expected = round(sum(legs) / len(legs), 1)
    assert rye["indicators"]["rain_on_bare_soil_mm"]["value"] == expected
    assert rye["indicators"]["rain_on_bare_soil_mm"]["per_leg"] == legs
    assert f"{expected:.1f} mm" in why["text"] and why["source"]["url"]
    # the dry-spring check trade-off is named, even though it is not in the priorities
    flags = rye["indicators"]["rule_flags"]
    assert "cr_tt_03" in flags["detail"]["rule_ids"]
    trade = [w for t in rye["trade_offs"] for w in t["worse_on"]]
    assert any(w["indicator"] == "rule_flags" and not w["in_priorities"] for w in trade)


def test_changing_weights_reorders_without_changing_values(client):
    goals_a = {"priorities": {"soil_cover": 3, "management_simplicity": 1}}
    goals_b = {"priorities": {"soil_cover": 1, "management_simplicity": 3}}
    a, b = _rec(client, {"goals": goals_a}), _rec(client, {"goals": goals_b})
    vals = lambda body: {c["candidate_id"]: {k: v["value"] for k, v in c["indicators"].items()}  # noqa: E731
                         for c in _all_cards(body)}  # fmt: skip
    assert vals(a) == vals(b)
    order_a = [c["candidate_id"] for c in a["shortlist"]]
    order_b = [c["candidate_id"] for c in b["shortlist"]]
    assert len(order_a) > 1 and sorted(order_a) == sorted(order_b) and order_a != order_b


def test_no_field_is_a_composite_score(client):
    body = _rec(client, {"goals": {"priorities": {"soil_cover": 2, "crop_diversity": 1}}})
    assert not [k for k in _keys(body) if "score" in k.lower()]


def test_excluded_crop_prunes_presets_and_logs_it(client):
    body = _rec(client, {"goals": {"constraints": {"excluded_crops": ["winter_wheat"]}}})
    assert "add_grain_crop" not in {c["candidate_id"] for c in _all_cards(body)}
    assert any(e["pruned"] == "add_grain_crop" for e in body["generation_log"])


def test_unknown_priority_is_invalid_input(client):
    r = client.post("/v1/plans/recommend", json={"goals": {"priorities": {"yield": 3}}})
    assert r.status_code == 400 and r.json()["status"] == "invalid_input"


def test_every_indicator_has_definition_source_origin(client):
    body = _rec(client, {})
    for card in _all_cards(body):
        for name, ind in card["indicators"].items():
            assert ind["definition"] and ind["source"]["title"] and ind["origin"], name
            assert ind["direction"] in ("lower_better", "higher_better")


# --------------------------------------------------------------------------- Pergamino


def test_pergamino_runs_with_its_own_thresholds(client):
    _prepare()
    no_cover = {**PLAN, "plan_id": "perg_bare", "winter": {"kind": "none"}}
    body = _rec(client, {"location": PERG, "goals": {"priorities": {"soil_cover": 3}},
                         "candidates": [{"candidate_id": "rye", "plans": [PLAN]},
                                        {"candidate_id": "bare", "plans": [no_cover]}]})  # fmt: skip
    assert body["status"] == "complete" and body["hemisphere"] == "south"
    assert body["thresholds"]["heavy_rain"]["method"] == "etccdi_r95p"
    from tests.compare.test_global_analysis import NC_CATALOG_VERSION, NC_RULE_IDS, _strings

    assert not body["meta"]["catalog_version"].startswith(NC_CATALOG_VERSION)
    assert not (_strings(body) & NC_RULE_IDS)
    assert [c["candidate_id"] for c in body["shortlist"]] == ["rye"]
    rye = body["shortlist"][0]
    flags = rye["indicators"]["rule_flags"]
    if flags["status"] == "unknown":  # no regional rules: unknown, never 0
        assert flags["value"] is None
    assert rye["indicators"]["crop_family_diversity"]["value"] == 2  # Poaceae + Fabaceae


def test_outside_nc_without_candidates_is_insufficient_data(client):
    _prepare()
    body = _rec(client, {"location": PERG})
    assert body["status"] == "insufficient_data" and body["gaps"] and body["shortlist"] == []


def test_outside_nc_without_weather_is_unavailable(client):
    body = _rec(client, {"location": PERG, "candidates": [{"candidate_id": "r", "plans": [PLAN]}]})
    assert body["status"] == "unavailable" and body["code"] == "offline_no_snapshot"


# --------------------------------------------------------------------------- review fixes (P2.md)


NC_RYE = {"plan_id": "nc_rye", "previous_crop_id": "field_corn", "next_crop_id": "soybean",
          "prev_harvest": "10-15", "next_plant": "05-12",
          "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "10-25", "terminate": "04-20"}}  # fmt: skip


def test_an_unsupported_crop_candidate_is_not_comparable_not_a_crash(client):
    odd = {**NC_RYE, "plan_id": "odd", "next_crop_id": "quinoa_unknown"}
    body = _rec(client, {"candidates": [{"candidate_id": "rye", "plans": [NC_RYE]},
                                        {"candidate_id": "odd", "plans": [odd]}],
                         "goals": {"priorities": {"soil_cover": 3}}})  # fmt: skip
    assert [c["candidate_id"] for c in body["not_comparable"]] == ["odd"]
    assert body["not_comparable"][0]["status"] == "unavailable" and body["status"] == "partial"


def test_wheat_double_crop_rule_lines_count(client):
    body = _rec(client, {"goals": {"priorities": {"weather_resilience": 2}}})
    wheat = next(c for c in _all_cards(body) if c["candidate_id"] == "add_grain_crop")
    flags = wheat["indicators"]["rule_flags"]
    assert "ww_rc_01" in flags["detail"]["rule_ids"] and flags["value"] > 0
    assert "sb_rc_03" in flags["detail"]["unknown_rule_ids"] and flags["status"] == "partial"


def test_replay_links_keep_the_location(client):
    body = _rec(client, {"location_id": "iredell", "goals": {"priorities": {"soil_cover": 3}}})
    hv = body["shortlist"][0]["historical_vulnerabilities"][0]["replay"]
    assert hv["method"] == "POST" and hv["body"]["location_id"] == "iredell"
    r = client.post(hv["path"], json=hv["body"])
    assert r.status_code == 200 and r.json()["weather_location"]["id"] == "iredell"


def test_result_id_follows_the_plan_contents(client):
    late = {**NC_RYE, "next_plant": "05-20"}
    a = _rec(client, {"candidates": [{"candidate_id": "x", "plans": [NC_RYE]}]})
    b = _rec(client, {"candidates": [{"candidate_id": "x", "plans": [late]}]})
    assert a["result_id"] != b["result_id"]
    assert a["meta"]["plan_version"] != b["meta"]["plan_version"]


def test_requested_rule_flags_unknown_outside_nc_make_candidates_not_comparable(client):
    from acre.compare.engine import has_rules  # noqa: F401 - documents the dependency

    _prepare()
    body = _rec(client, {"location": PERG, "goals": {"priorities": {"weather_resilience": 3}},
                         "candidates": [{"candidate_id": "rye", "plans": [PLAN]}]})  # fmt: skip
    rye = _all_cards(body)[0]
    if rye["indicators"]["rule_flags"]["status"] == "unknown":  # no regional rules loaded
        assert body["shortlist"] == [] and body["not_comparable"][0]["missing"] == ["rule_flags"]
        assert body["status"] == "insufficient_data"


# --------------------------------------------------------------------------- review r2 fixes (P2-r2.md)


def test_border_point_replay_keeps_its_global_scope(client):
    sc = {"latitude": 34.78, "longitude": -80.6}  # South Carolina, in Union County's cell
    body = _rec(client, {"location": sc, "goals": {"priorities": {"soil_cover": 3}},
                         "candidates": [{"candidate_id": "rye", "plans": [NC_RYE]}]})  # fmt: skip
    hv = body["shortlist"][0]["historical_vulnerabilities"][0]["replay"]
    assert hv["body"]["location"] == {"latitude": 34.78, "longitude": -80.6}
    rep = client.post(hv["path"], json=hv["body"]).json()
    assert rep["thresholds"]["heavy_rain"]["method"] == "etccdi_r95p"  # still outside NC


def test_generator_failure_keeps_its_status_and_reason(client, monkeypatch):
    import acre.api.recommend_routes as rr

    monkeypatch.setattr(rr, "generate", lambda *a: {
        "status": "unavailable", "reason": "candidate_generator_failed", "candidates": [],
        "generation_log": [], "gaps": ["The plan generator failed."]})
    body = _rec(client, {"goals": {"priorities": {"soil_cover": 3}}})
    assert body["status"] == "unavailable" and body["reason"] == "candidate_generator_failed"
    assert body["reason_text"]


# --------------------------------------------------------------------------- milestone review (A-m1)


def test_partial_indicators_never_enter_dominance(client):
    body = _rec(client, {"goals": {"priorities": {"weather_resilience": 3}}})
    wheat = next(c for c in _all_cards(body) if c["candidate_id"] == "add_grain_crop")
    assert wheat["indicators"]["rule_flags"]["status"] == "partial"
    nc = {c["candidate_id"]: c["missing"] for c in body["not_comparable"]}
    assert "rule_flags" in nc["add_grain_crop"]


def test_unprepared_outside_nc_compare_shows_nothing_of_union(client):
    r = client.post("/v1/plans/compare", json={"plans": [PLAN], "location": PERG,
                                               "include_soil": False})  # fmt: skip
    body = r.json()
    assert body["thresholds"]["heavy_rain"]["value"] is None
    assert body["thresholds"]["dry_spring"] == {} and body["meta"]["catalog_version"] is None


def test_semantic_leg_cache_reuses_calculations_and_keeps_each_plan_identity(monkeypatch):
    from acre.compare import engine, locations
    from acre.compare import recommend as rec
    from acre.compare.models import PlanComparison
    from acre.contracts import Plan, Status

    ctx = locations.choose(None, latitude=34.98, longitude=-80.55).ctx
    assert ctx is not None
    rec._LEG_CACHE.clear()
    from acre.api.samples import load_samples

    original = load_samples().plans["corn_soy__no_cover"].plan
    assert original is not None
    first = original.model_copy(update={"plan_id": "first", "label": "First field"})
    second = original.model_copy(update={"plan_id": "second", "label": "Second field"})
    calls = []

    def analyze(plan, context, thresholds, *, full_season_plan):
        calls.append(plan)
        return PlanComparison(plan_id=plan.plan_id, label=plan.label,
                              status=Status.COMPLETE, plan=plan), {}

    monkeypatch.setattr(engine, "analyze_plan", analyze)
    cands = [rec.Candidate("a", [first]), rec.Candidate("b", [second])]
    try:
        legs, _ = rec.analyze_candidates(cands, ctx)
        assert len(calls) == 1
        for key, expected in (("a", first), ("b", second)):
            result = legs[key][0]
            assert result.plan_id == expected.plan_id and result.label == expected.label
            assert result.plan == expected and result.plan is not expected
        legs["a"][0].plan = legs["a"][0].plan.model_copy(update={"label": "mutated result"})
        again, _ = rec.analyze_candidates(cands, ctx)
        assert again["a"][0].plan.label == "First field"
        assert again["b"][0].plan.label == "Second field" and len(calls) == 1
        changed = Plan.model_validate({**second.model_dump(), "next_plant": "05-13"})
        rec.analyze_candidates([rec.Candidate("changed", [changed])], ctx)
        assert len(calls) == 2
    finally:
        rec._LEG_CACHE.clear()


def test_cached_wheat_rebinds_its_plan_and_cross_calendar_baseline():
    from acre.api.samples import load_samples
    from acre.compare import recommend as rec
    from acre.compare.models import PlanComparison
    from acre.contracts import Status

    original = load_samples().plans["corn_soy__no_cover"].plan
    plan = original.model_copy(update={"plan_id": "wheat_request", "label": "My wheat"})
    full = original.model_copy(update={"plan_id": "baseline_request"})
    cached = PlanComparison(
        plan_id="cached", label=None, status=Status.PARTIAL, plan=original,
        double_crop={"plan_id": "cached", "cross_calendar": {
            "full_season": {"plan_id": "cached_baseline"},
            "double_crop": {"plan_id": "cached"}}})
    result = rec._candidate_leg(cached, plan, full)
    assert result.double_crop["plan_id"] == "wheat_request"
    assert result.double_crop["cross_calendar"]["full_season"]["plan_id"] == "baseline_request"
    assert result.double_crop["cross_calendar"]["double_crop"]["plan_id"] == "wheat_request"
    assert cached.double_crop["plan_id"] == "cached"
