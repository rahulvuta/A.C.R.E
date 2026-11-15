"""S3: economics estimate against labelled synthetic fixtures (never real numbers)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from acre.economics import EconomicsInputError, data, estimate_economics

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "economics"
UNION = {"latitude": 34.98, "longitude": -80.55}
PERGAMINO = {"latitude": -33.89, "longitude": -60.57}


@pytest.fixture(autouse=True)
def _fixtures(monkeypatch):
    monkeypatch.setenv("ACRE_ECONOMICS_DIR", str(FIX))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    data.clear_cache()
    yield
    data.clear_cache()


def crop(out, cid):
    return next(c for c in out["crops"] if c["crop_id"] == cid)


def test_us_location_uses_the_most_specific_sourced_region_and_us_units():
    out = estimate_economics(UNION, ["soybean", "field_corn"], {"value": 40, "unit": "ha"},
                             ["grain_drill", "sprayer", "roller_crimper"])  # fmt: skip
    assert out["currency"] == "USD" and out["area_unit"] == "acre"
    soy = crop(out, "soybean")
    assert soy["status"] == "complete"
    p = soy["price"]
    assert (p["low"], p["typical"], p["high"], p["unit"]) == (9.5, 11.2, 13.6, "USD/bu")
    assert p["origin"] == "verified_source" and p["source"]["region_key"] == "US-NC"  # NC over US
    y = soy["yield"]
    assert y["value"] == 44 and y["unit"] == "bu/acre" and y["origin"] == "dataset_estimate"
    assert y["source"]["year"] == "2024"  # newest year
    c = soy["costs"]
    assert [i["item"] for i in c["items"]] == ["fertilizer", "other", "seed"]  # one budget only
    assert c["total_per_area"]["value"] == 410 and c["total_per_area"]["unit"] == "USD/acre"
    assert soy["revenue_per_area"]["typical"] == round(11.2 * 44, 2)
    assert soy["margin_per_area"] == {"low": round(9.5 * 44 - 410, 2),
                                      "typical": round(11.2 * 44 - 410, 2),
                                      "high": round(13.6 * 44 - 410, 2), "unit": "USD/acre",
                                      "currency": "USD", "origin": "calculation"}  # fmt: skip
    acres = 40 * 2.4710538146716534
    assert soy["for_area"]["area"]["value"] == round(acres, 3)
    assert soy["for_area"]["margin"]["typical"] == round(soy["margin_per_area"]["typical"] * acres, 2)
    # maize: a US price, no yield, and its only cost row had a bad number (dropped) -> partial
    corn = crop(out, "maize")
    assert corn["status"] == "partial" and corn["yield"] is None and corn["margin_per_area"] is None
    assert "no sourced yield" in corn["reason_text"]
    eqc = {(e["equipment"], e["pass"]): e for e in out["equipment_costs"]}
    assert eqc[("grain_drill", "drill")]["value"] == 18.5 and ("sprayer", "spray") in eqc
    assert any("roller_crimper" in g for g in out["gaps"])


def test_outside_the_us_hectares_tonnes_and_the_source_currency():
    out = estimate_economics(PERGAMINO, ["soybean", "maize"], {"value": 100, "unit": "acre"})
    assert out["area_unit"] == "ha" and out["currency"] == "USD"
    soy = crop(out, "soybean")
    assert soy["price"]["unit"] == "USD/t" and soy["yield"]["unit"] == "t/ha"
    assert soy["revenue_per_area"]["typical"] == round(300 * 2.9, 2)
    assert soy["status"] == "partial" and soy["margin_per_area"] is None  # no AR costs: no margin
    assert soy["for_area"]["revenue"]["typical"] == round(870 * 100 / 2.4710538146716534, 2)


def test_overrides_come_first_and_are_grower():
    out = estimate_economics(UNION, ["soybean"], None, [], {
        "soybean": {"price": {"value": 12.0, "unit": "USD/bu"},
                    "yield": {"value": 50, "unit": "bu/acre"},
                    "costs": {"total": {"value": 400, "unit": "USD/acre"}}}})  # fmt: skip
    soy = crop(out, "soybean")
    assert soy["price"]["origin"] == soy["yield"]["origin"] == "grower"
    assert soy["price"]["low"] == soy["price"]["typical"] == soy["price"]["high"] == 12.0
    assert soy["margin_per_area"]["typical"] == 200.0 and "for_area" not in soy


def test_no_source_and_no_override_is_unavailable_with_nulls():
    out = estimate_economics(UNION, ["sorghum"])  # its price row has no source URL: dropped
    s = crop(out, "sorghum")
    assert s["status"] == "unavailable" and s["price"] is None and s["yield"] is None
    assert s["margin_per_area"] is None and s["reason_text"].startswith("No money result")
    assert out["status"] == "unavailable"
    issues = data.load().issues
    assert any(i["file"] == "prices.csv" and "source_url" in i["message"] for i in issues)


def test_no_other_regions_numbers_are_borrowed():
    out = estimate_economics({"region_key": "BR-PR"}, ["soybean"])
    assert crop(out, "soybean")["status"] == "unavailable"
    fr = estimate_economics({"latitude": 48.8, "longitude": 2.3}, ["soybean"])  # no region known
    assert crop(fr, "soybean")["status"] == "unavailable"
    assert any("No region is known" in g for g in fr["gaps"])


def test_mismatched_units_give_no_revenue():
    out = estimate_economics(PERGAMINO, ["soybean"], None, [], {
        "soybean": {"yield": {"value": 40, "unit": "bu/acre"}}})  # USD/t price vs bushels
    soy = crop(out, "soybean")
    assert soy["revenue_per_area"] is None and "units don't match" in soy["reason_text"]


def test_missing_reference_data_is_a_gap_not_an_error(monkeypatch, tmp_path):
    monkeypatch.setenv("ACRE_ECONOMICS_DIR", str(tmp_path))
    out = estimate_economics(UNION, ["soybean"])
    assert crop(out, "soybean")["status"] == "unavailable"
    assert any("E0" in g for g in out["gaps"])


@pytest.mark.parametrize("args, field", [
    ((UNION, []), "crops"),
    ((UNION, ["soybean"], {"value": -1, "unit": "acre"}), "area"),
    ((UNION, ["soybean"], {"value": 1, "unit": "sqft"}), "area"),
    ((UNION, ["soybean"], None, ["jetpack"]), "equipment"),
    ((UNION, ["soybean"], None, [], {"soybean": {"price": {"value": 1}}}), "overrides.soybean.price"),
    ((UNION, ["soybean"], None, [], {"soybean": {"profit": 1}}), "overrides.soybean"),
])  # fmt: skip
def test_bad_input_is_typed(args, field):
    with pytest.raises(EconomicsInputError) as e:
        estimate_economics(*args)
    assert e.value.field == field


def test_loss_assumptions_are_echoed_as_assumed():
    out = estimate_economics(UNION, ["soybean"], loss_assumptions={"dry_spring_pct": 15,
                                                                    "heavy_rain_pct": None})  # fmt: skip
    la = out["loss_assumptions"]
    assert la["dry_spring_pct"]["origin"] == "assumed" and la["heavy_rain_pct"] is None
    with pytest.raises(EconomicsInputError):
        estimate_economics(UNION, ["soybean"], loss_assumptions={"dry_spring_pct": 150})


def test_route():
    from acre.api.app import create_app

    api = TestClient(create_app())
    r = api.post("/v1/economics/estimate", json={"location": UNION, "crops": ["soybean"],
                                                 "area": {"value": 10, "unit": "acre"},
                                                 "equipment": ["grain_drill"]})  # fmt: skip
    body = r.json()
    assert r.status_code == 200 and "meta" in body and body["crops"][0]["status"] == "complete"
    bad = api.post("/v1/economics/estimate", json={"location": UNION, "crops": []})
    assert bad.status_code == 400 and bad.json()["issues"][0]["field"] == "crops"


@pytest.mark.parametrize("yield_basis,cost_basis,has_margin", [
    ("harvested", "planted", False), ("planted", "harvested", False),
    ("planted", "planted", True), ("unknown", "planted", True),
    ("harvested", "", True), ("harvested", "unknown", True),
])
def test_sourced_area_basis_is_retained_and_conflicts_block_margin(
        tmp_path, monkeypatch, yield_basis, cost_basis, has_margin):
    import csv

    for name in data.FILES:
        with (FIX / f"{name}.csv").open() as f:
            reader = csv.DictReader(f)
            fields = list(reader.fieldnames)
            rows = list(reader)
        if name in {"yields", "costs"}:
            fields.append("area_basis")
            for row in rows:
                row["area_basis"] = yield_basis if name == "yields" else cost_basis
        with (tmp_path / f"{name}.csv").open("w", newline="") as f:
            writer = csv.DictWriter(f, fields)
            writer.writeheader()
            writer.writerows(rows)
    monkeypatch.setenv("ACRE_ECONOMICS_DIR", str(tmp_path))
    out = crop(estimate_economics(UNION, ["soybean"]), "soybean")
    assert out["yield"]["area_basis"] == yield_basis
    assert data.load().yields[0]["area_basis"] == yield_basis
    total = out["costs"]["total_per_area"]
    assert total.get("area_basis") == (cost_basis or None)
    assert (out["margin_per_area"] is not None) is has_margin
    assert out["revenue_per_area"] is not None
    if not has_margin:
        assert out["status"] == "partial"
        assert "no margin without a sourced area-basis conversion" in out["reason_text"]
    # Grower inputs carry no invented planted/harvested conversion.
    grower = crop(estimate_economics(UNION, ["soybean"], overrides={
        "soybean": {"yield": {"value": 50, "unit": "bu/acre"}}}), "soybean")
    assert grower["margin_per_area"] is not None


@pytest.mark.parametrize("price", [
    {"value": 1, "unit": 42}, {"value": 1, "unit": "USD/"},
    {"value": float("nan"), "unit": "USD/bu"},
    {"value": float("inf"), "unit": "USD/bu"},
    {"low": 1, "unit": "USD/bu"},
    {"low": 8, "typical": 4, "high": 1, "unit": "USD/bu"},
])
def test_malformed_money_overrides_have_typed_errors(price):
    with pytest.raises(EconomicsInputError):
        estimate_economics(UNION, ["soybean"], overrides={"soybean": {"price": price}})


def test_nonfinite_area_has_a_typed_error():
    with pytest.raises(EconomicsInputError):
        estimate_economics(UNION, ["soybean"], area={"value": float("inf"), "unit": "acre"})
