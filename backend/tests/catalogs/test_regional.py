"""B2: catalog v3, generalised crop ids, SAGE calendars and the catalog for a location.

Offline: the geocoder only reads committed fixtures (Pergamino, the NC points) or the test cache.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fieldshift.catalogs import crop_ids, regional, sage, v3
from fieldshift.catalogs.loader import V1_CATALOG_DIR, V2_CATALOG_DIR, load_catalog
from fieldshift.catalogs.regional import RegionalIndex, catalog_for_location, regional_catalog
from fieldshift.contracts import Plan
from fieldshift.planner.checker import check_plan
from fieldshift.report.meta import get_index

PERGAMINO = (-33.89, -60.57)
UNION = (34.98, -80.55)
# three non-NC points on land: Argentina, Iowa (U.S., not NC) and the Paris basin
NON_NC = {"pergamino": PERGAMINO, "iowa": (41.52, -91.65), "paris": (48.6, 2.3)}
SAMPLES = json.loads((Path(__file__).resolve().parents[2] / "data" / "samples" /
                      "union_plans.json").read_text())["samples"]  # fmt: skip
YEAR = 2027


def sample(plan_id: str) -> Plan:
    return Plan.model_validate(next(s["plan"] for s in SAMPLES if s["plan_id"] == plan_id))


@pytest.fixture(autouse=True)
def _offline_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FIELDSHIFT_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("FIELDSHIFT_OFFLINE", "1")
    regional.clear_cache()
    yield
    regional.clear_cache()


@pytest.fixture()
def client():
    from fieldshift.api.app import create_app

    return TestClient(create_app())


NC_RULE_IDS = set(get_index().rules)


# --------------------------------------------------------------------------- crop ids


def test_aliases_map_old_ids_both_ways():
    assert crop_ids.canonical("field_corn") == "maize" and crop_ids.canonical("MAIZE") == "maize"
    assert crop_ids.canonical("dragon_fruit") is None
    assert crop_ids.id_in_catalog("maize", get_index().crops) == "field_corn"
    assert crop_ids.id_in_catalog("field_corn", {"maize": 1}) == "maize"
    assert crop_ids.family_of("soybean") == "Fabaceae" and crop_ids.family_of("field_corn") == (
        "Poaceae"
    )


def test_every_sage_crop_and_nc_crop_is_in_the_crop_list():
    for cid in json.loads(sage.META_PATH.read_text())["crops"]:
        assert crop_ids.is_known(cid), cid
    for c in get_index().catalog.crops:
        assert crop_ids.is_known(c.crop_id), c.crop_id


# --------------------------------------------------------------------------- catalog v3


def test_v1_and_v2_rows_load_as_verified_nc_and_stay_untouched():
    for d in (V1_CATALOG_DIR, V2_CATALOG_DIR):
        cat = load_catalog(d)
        assert cat.rules and all(r.origin == "verified_source" and r.region_key == "US-NC"
                                 for r in cat.rules)  # fmt: skip
        assert all(c.origin == "verified_source" for c in cat.crops)


V3_ROW = {
    "rule_id": "ar_b_t_01", "crop_id": "soybean", "region": "Buenos Aires",
    "rule_type": "rotation_compatibility", "previous_crop_id": "soybean",
    "suitability": "avoid", "applies_when": "soybean after soybean",
    "guidance": "Avoid soybean after soybean.", "source_title": "Synthetic fixture source",
    "source_url": "https://example.invalid/fixture", "source_locator": "p. 1",
    "verified_date": "", "region_key": "AR-B", "country": "AR", "admin1": "AR-B", "koppen": "Cfa",
    "origin": "ai_suggested", "evidence_quote": "avoid soybean after soybean",
    "limitations": "synthetic fixture", "conflicts_with": "",
}  # fmt: skip


def v3_csv(*rows: dict[str, str]) -> str:
    import csv
    import io

    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=v3.HEADER)
    w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, "") for k in v3.HEADER})
    return buf.getvalue()


def test_v3_rows_parse_with_their_region_and_origin():
    rules, issues = v3.parse_rules_text(v3_csv(V3_ROW), set(crop_ids.BY_ID))
    assert [r.rule_id for r in rules] == ["ar_b_t_01"]
    r = rules[0]
    assert (r.region_key, r.origin, r.koppen, r.evidence_quote) == (
        "AR-B", "ai_suggested", "Cfa", "avoid soybean after soybean")


@pytest.mark.parametrize("change, code", [
    ({"region_key": ""}, "v3_region_missing"),
    ({"origin": "verified"}, "v3_origin_invalid"),
    ({"origin": "nasa_modeled"}, "v3_origin_invalid"),
    ({"evidence_quote": " ".join(["word"] * 31)}, "v3_quote_too_long"),
])  # fmt: skip
def test_bad_v3_rows_are_dropped_with_a_typed_issue(change, code):
    good = {**V3_ROW, "rule_id": "ar_b_t_02"}
    rules, issues = v3.parse_rules_text(v3_csv({**V3_ROW, **change}, good), set(crop_ids.BY_ID))
    assert [r.rule_id for r in rules] == ["ar_b_t_02"]
    assert code in {i.code for i in issues}


def test_a_v2_header_without_v3_columns_is_rejected():
    text = v3_csv(V3_ROW).split("\n", 1)[1]
    header = ",".join(v3.HEADER[: -len(v3.V3_COLUMNS)])
    rules, issues = v3.parse_rules_text(header + "\n" + text)
    assert rules == [] and issues[0].code == "header_missing"


# --------------------------------------------------------------------------- SAGE


def test_pergamino_sage_profile_lists_soybean_and_maize_as_dataset_estimates():
    idx = regional_catalog(*PERGAMINO)
    assert not idx.in_nc and idx.region_keys[:2] == ["AR-B", "AR"]
    for crop in ("soybean", "maize"):
        cal = idx.calendar(crop)
        assert cal["origin"] == "dataset_estimate" and cal["extrapolated"] is False
        assert "Sacks" in cal["source"]["citation"] and cal["source"]["url"].startswith("https://")
        assert cal["plant"]["start"] and cal["harvest"]["end"]
    # southern hemisphere: soybean is sown in spring (Oct-Dec) and harvested in autumn (Mar-May)
    assert idx.calendar("soybean")["plant"]["start"][:2] in ("10", "11")
    assert idx.calendar("soybean")["harvest"]["start"][:2] in ("03", "04")
    assert idx.calendar("field_corn") == idx.calendar("maize")  # the alias finds the calendar


def test_sage_windows_crossing_new_year_are_marked():
    w = sage.Window("11-01", "01-15", "12-01")
    assert w.crosses_new_year and not sage.Window("03-01", "05-01", None).crosses_new_year
    assert sage.mm_dd(1) == "01-01" and sage.mm_dd(365) == "12-31"


def test_extrapolated_sage_cells_are_kept_flagged_and_listed_as_gaps():
    idx = regional_catalog(*PERGAMINO)
    flagged = [c for c, cal in idx.calendars.items() if cal["extrapolated"]]
    assert flagged and all(any(idx.crops[c].common_name.split(" (")[0] in g for g in idx.gaps)
                           for c in flagged)  # fmt: skip


def test_the_sage_cell_label_is_the_cell_centre_not_the_point():
    assert sage.cell_label(*PERGAMINO) == "sage_-33.75_-60.75"
    assert "-33.89" not in regional_catalog(*PERGAMINO).version


# --------------------------------------------------------------------------- catalog_for_location


def test_nc_gets_the_verified_v2_catalog_unchanged():
    idx, state = catalog_for_location({"latitude": UNION[0], "longitude": UNION[1]})
    assert idx is get_index()
    assert state["status"] == "complete" and state["origin"] == "verified_source"


@pytest.mark.parametrize("name", sorted(NON_NC))
def test_no_nc_rule_ever_reaches_a_non_nc_point(name):
    lat, lon = NON_NC[name]
    idx, state = catalog_for_location({"latitude": lat, "longitude": lon})
    assert isinstance(idx, RegionalIndex) and not idx.in_nc
    assert not (set(idx.rules) & NC_RULE_IDS)
    assert state["status"] in ("partial", "insufficient_data")
    assert "US-NC" not in idx.region_keys
    for pid in ("corn_soy__no_cover", "soy_corn__no_cover"):
        res = check_plan(sample(pid), idx, year=YEAR)
        assert not ({r.rule_id for r in res.rules} & NC_RULE_IDS)


def test_cell_id_locations_work_and_bad_ones_are_typed():
    idx, state = catalog_for_location({"cell_id": "cell_-34.000_-60.625"})
    assert isinstance(idx, RegionalIndex) and idx.calendar("soybean")
    _, bad = catalog_for_location({"latitude": 200, "longitude": 0})
    assert bad["reason"] == "invalid_location" and bad["status"] == "unknown"


def test_old_sample_plans_stay_valid_outside_nc_through_aliases():
    idx = regional_catalog(*PERGAMINO)
    res = check_plan(sample("corn_soy__no_cover"), idx, year=YEAR)
    assert res.status == "complete", res.unsupported  # field_corn is maize here
    assert res.rules == []  # SAGE-only: no rules, so nothing is checked (not "all clear")


def test_nc_accepts_the_generalised_id_and_gives_the_same_result():
    base = sample("corn_soy__rye")
    a = check_plan(base, get_index(), year=YEAR)
    b = check_plan(base.model_copy(update={"previous_crop_id": "maize"}), get_index(), year=YEAR)
    assert [r.model_dump() for r in a.rules] == [r.model_dump() for r in b.rules]


def test_unknown_crop_is_invalid_input_naming_the_field_outside_nc():
    idx = regional_catalog(*PERGAMINO)
    res = check_plan(sample("corn_soy__no_cover").model_copy(update={"next_crop_id": "quinoa_x"}),
                     idx, year=YEAR)  # fmt: skip
    assert res.status == "invalid_input"
    assert [(i.field, i.code) for i in res.issues] == [("next_crop_id", "unknown_crop")]


def write_profile(root: Path, key: str = "AR-B", rows: tuple[dict, ...] = (V3_ROW,), **extra):
    d = root / "regions" / key.replace(":", "_")
    d.mkdir(parents=True, exist_ok=True)
    doc = {"region_key": key, "origin": "ai_suggested",
           "cover_crops": [{"crop_id": "cereal_rye", "origin": "ai_suggested", "sources": []}],
           "rotations": [{"label": "Maize, then soybean", "sequence": ["maize", "soybean"],
                          "origin": "ai_suggested", "sources": []}],
           "gaps": ["No local source for cover termination timing."], **extra}  # fmt: skip
    (d / "profile.json").write_text(json.dumps(doc))
    (d / "crop_rules.csv").write_text(v3_csv(*rows))
    return d


def test_a_stored_profile_is_used_with_its_rules_and_their_origin(tmp_path):
    other = {**V3_ROW, "rule_id": "fr_x_01", "region_key": "FR-IDF"}  # wrong region: dropped
    write_profile(tmp_path / "cache", rows=(V3_ROW, other))
    idx, state = catalog_for_location({"latitude": PERGAMINO[0], "longitude": PERGAMINO[1]})
    assert state["status"] == "partial" and state["origin"] == "ai_suggested"
    assert state["region_key"] == "AR-B" and set(idx.rules) == {"ar_b_t_01"}
    assert idx.crop("cereal_rye").crop_role == "cover_crop"
    assert idx.calendar("soybean")["origin"] == "dataset_estimate"  # SAGE still fills calendars
    soy = Plan.model_validate({**sample("soy_corn__no_cover").model_dump(),
                               "next_crop_id": "soybean", "next_plant": "11-15",
                               "prev_harvest": "04-20"})  # fmt: skip
    res = check_plan(soy, idx, year=YEAR)
    chk = res.rule("ar_b_t_01")
    assert chk is not None and chk.origin == "ai_suggested" and chk.region_key == "AR-B"
    assert chk.flagged and chk.verdict == "avoid" and chk.print is False  # AI rows never print


def test_a_profile_is_never_borrowed_from_nc_or_another_region(tmp_path):
    write_profile(tmp_path / "cache", key="FR-IDF")
    write_profile(tmp_path / "cache", key="US-NC")
    idx, state = catalog_for_location({"latitude": PERGAMINO[0], "longitude": PERGAMINO[1]})
    assert state["reason"] == "sage_only" and state["origin"] == "dataset_estimate"
    assert idx.profile is None or (idx.profile_key == "AR-B" and idx.profile["origin"] == (
        "dataset_estimate"))  # only AR-B's own committed SAGE placeholder, never FR-IDF or NC


def test_a_place_with_no_calendars_and_no_profile_is_insufficient_data():
    idx, state = catalog_for_location({"latitude": -80.0, "longitude": 0.0})  # Antarctic ice
    if isinstance(idx, RegionalIndex) and not idx.calendars:
        assert state["status"] == "insufficient_data" and state["gaps"]


# --------------------------------------------------------------------------- HTTP


def test_profile_route_pergamino_sage_only(client):
    r = client.get("/v1/regions/AR-B/profile", params={"lat": PERGAMINO[0], "lon": PERGAMINO[1]})
    j = r.json()
    assert r.status_code == 200 and j["status"] == "partial" and j["region_key"] == "AR-B"
    crops = {c["crop_id"]: c for c in j["crops"]}
    for cid in ("soybean", "maize"):
        assert crops[cid]["calendar"]["origin"] == "dataset_estimate"
        assert crops[cid]["calendar"]["source"]["title"]
    assert j["rules"] == [] and j["disclaimer"] and j["gaps"]
    assert not (NC_RULE_IDS & {x["rule_id"] for x in j["rules"]})
    assert "meta" in j and set(j["meta"]) >= {"plan_version", "catalog_version", "snapshot_hash",
                                             "request_id"}  # fmt: skip


def test_profile_route_nc_is_complete_and_all_verified(client):
    j = client.get("/v1/regions/US-NC/profile").json()
    assert j["status"] == "complete" and j["rules"]
    assert {x["origin"] for x in j["rules"]} == {"verified_source"}


def test_profile_route_errors(client):
    assert client.get("/v1/regions/not a key/profile").status_code == 400
    r = client.get("/v1/regions/FR-IDF/profile", params={"lat": PERGAMINO[0], "lon": PERGAMINO[1]})
    assert r.status_code == 400 and r.json()["issues"][0]["code"] == "region_mismatch"
    assert client.get("/v1/regions/AR-B/profile", params={"lat": "x"}).status_code == 400
    j = client.get("/v1/regions/BR-PR/profile").json()  # no profile stored for this region
    assert j["status"] == "unavailable" and j["reason"] == "no_profile" and j["reason_text"]


@pytest.mark.parametrize("key", ["AR-B", "IN-PB", "FR-IDF"])
def test_committed_demo_profiles_are_sage_only_and_say_so(client, key):
    j = client.get(f"/v1/regions/{key}/profile").json()
    assert j["status"] == "partial" and j["origin"] == "dataset_estimate" and j["rules"] == []
    assert j["research"]["reason"] == "research_not_configured" and j["gaps"]


def test_check_and_crops_routes_follow_the_location(client):
    body = {"plan": sample("corn_soy__no_cover").model_dump(mode="json"), "year": YEAR,
            "location": {"latitude": PERGAMINO[0], "longitude": PERGAMINO[1]}}  # fmt: skip
    j = client.post("/v1/plans/check", json=body).json()
    assert j["result"]["status"] == "complete" and j["catalog"]["region_key"] == "AR-B"
    assert not (NC_RULE_IDS & {r["rule_id"] for r in j["result"]["rules"]})
    nc = client.post("/v1/plans/check", json={k: v for k, v in body.items() if k != "location"})
    assert "catalog" not in nc.json() and nc.json()["result"]["rules"]
    bad = {**body, "plan": {**body["plan"], "next_crop_id": "quinoa_x"}}
    r = client.post("/v1/plans/check", json=bad)
    assert r.status_code == 400 and r.json()["issues"][0]["field"] == "plan.next_crop_id"
    assert client.post("/v1/plans/check", json={**body, "location": "x"}).status_code == 400
    crops = client.get("/v1/crops", params={"lat": PERGAMINO[0], "lon": PERGAMINO[1]}).json()
    assert {c["origin"] for c in crops["crops"]} == {"dataset_estimate"}
    assert "soybean" in {c["crop_id"] for c in crops["crops"]}


# --------------------------------------------------------------------------- review fixes (B2.md)


def test_finder_windows_crossing_new_year_resolve_across_years():
    from datetime import date

    from fieldshift.planner.finder import _window_around

    assert _window_around(date(2026, 10, 20), "11-15", "01-31") == (date(2026, 11, 15),
                                                                   date(2027, 1, 31))  # fmt: skip
    assert _window_around(date(2027, 1, 10), "11-15", "01-31") == (date(2026, 11, 15),
                                                                  date(2027, 1, 31))  # fmt: skip
    # a plain window keeps its year, even when harvest is already past it (the caller notes it)
    assert _window_around(date(2026, 10, 20), "08-25", "10-01") == (date(2026, 8, 25),
                                                                   date(2026, 10, 1))  # fmt: skip


def test_finder_gives_the_same_options_for_an_alias():
    from fieldshift.planner.finder import find_plans

    base = sample("corn_soy__no_cover")
    a = find_plans(base, get_index(), year=YEAR)
    b = find_plans(base.model_copy(update={"previous_crop_id": "maize"}), get_index(), year=YEAR)
    assert [o.model_dump() for o in a.options] == [o.model_dump() for o in b.options]


def test_declared_v3_conflicts_are_marked(tmp_path):
    r1 = {**V3_ROW, "rule_id": "ar_b_t_01", "conflicts_with": "ar_b_t_02"}
    r2 = {**V3_ROW, "rule_id": "ar_b_t_02", "suitability": "acceptable", "conflicts_with": ""}
    write_profile(tmp_path / "cache", rows=(r1, r2))
    idx = regional_catalog(*PERGAMINO)
    soy = Plan.model_validate({**sample("soy_corn__no_cover").model_dump(),
                               "next_crop_id": "soybean", "next_plant": "11-15",
                               "prev_harvest": "04-20"})  # fmt: skip
    res = check_plan(soy, idx, year=YEAR)
    a, b = res.rule("ar_b_t_01"), res.rule("ar_b_t_02")
    assert a.conflict and b.conflict and "ar_b_t_02" in a.conflicts_with
    assert a.print is False  # an unconfirmed AI row never prints, even in conflict


def test_regional_meta_names_its_catalog_and_no_snapshot(client):
    body = {"plan": sample("corn_soy__no_cover").model_dump(mode="json"), "year": YEAR,
            "location": {"latitude": PERGAMINO[0], "longitude": PERGAMINO[1]}}  # fmt: skip
    m = client.post("/v1/plans/check", json=body).json()["meta"]
    assert m["catalog_version"].startswith("v3:AR-B:") and m["snapshot_hash"] is None
    p = client.get("/v1/regions/AR-B/profile",
                   params={"lat": PERGAMINO[0], "lon": PERGAMINO[1]}).json()["meta"]
    assert p["catalog_version"].startswith("v3:AR-B:") and p["snapshot_hash"] is None
    nc = client.post("/v1/plans/check", json={k: v for k, v in body.items() if k != "location"})
    assert nc.json()["meta"]["catalog_version"].startswith("v2:")


def test_stored_profiles_cannot_claim_an_unknown_origin(tmp_path):
    d = write_profile(tmp_path / "cache", origin="verified")
    idx, state = catalog_for_location({"latitude": PERGAMINO[0], "longitude": PERGAMINO[1]})
    assert idx.profile is None and any("no valid origin" in g for g in idx.gaps)
    doc = json.loads((d / "profile.json").read_text())
    doc["origin"] = "ai_suggested"
    doc["cover_crops"].append({"crop_id": "cereal_rye", "origin": "nasa_measured"})
    (d / "profile.json").write_text(json.dumps(doc))
    regional.clear_cache()
    idx = regional_catalog(*PERGAMINO)
    assert [c["origin"] for c in idx.cover_crop_options()] == ["ai_suggested"]


# --------------------------------------------------------------------------- review fixes (B2-r2.md)


def test_profile_crop_origin_flows_into_its_calendar_and_crops_without_calendars_stay(tmp_path):
    write_profile(tmp_path / "cache", rows=(), crops=[
        {"crop_id": "soybean", "origin": "ai_suggested",
         "calendar": {"plant": {"start": "11-01", "end": "12-01"}}},
        {"crop_id": "sunflower", "origin": "source_checked"}])  # fmt: skip
    idx = regional_catalog(*PERGAMINO)
    assert idx.calendar("soybean")["origin"] == "ai_suggested"  # never the profile-level default
    assert idx.crop("sunflower") is not None


def test_an_invalid_explicit_origin_drops_the_entry_even_with_a_valid_calendar_origin(tmp_path):
    write_profile(tmp_path / "cache", rows=(), crops=[
        {"crop_id": "soybean", "origin": "verified",
         "calendar": {"origin": "dataset_estimate", "plant": {"start": "11-01", "end": "12-01"}}}])  # fmt: skip
    idx = regional_catalog(*PERGAMINO)
    assert idx.calendar("soybean")["origin"] == "dataset_estimate"  # SAGE's own, not the profile's
    assert idx.calendar("soybean")["source"]["citation"]


def test_finder_uses_regional_rows_outside_nc(tmp_path):
    from fieldshift.planner.finder import _region_ok

    row = v3.parse_rules_text(v3_csv({**V3_ROW, "region": "Some Province"}))[0][0]
    assert _region_ok(row, None) and _region_ok(row, "NC Piedmont")
