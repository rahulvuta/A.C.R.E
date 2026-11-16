"""Card 29: town-market prices and exchange rates. Synthetic tables in a temp folder for the rules;
one read of the real tables to check they load cleanly. No network."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from acre.api.app import create_app
from acre.economics import EconomicsInputError, data, estimate_economics, fx

KITALE = {"latitude": 1.02, "longitude": 35.0}
SRC = "SYNTHETIC,https://fixture.invalid/x,row 1,2026-11-01"
REAL = Path(__file__).resolve().parents[2] / "data" / "economics"


def _tables(tmp_path: Path) -> None:
    (tmp_path / "prices.csv").write_text(
        "region_key,crop_id,unit,currency,low,typical,high,years,source_title,source_url,locator,retrieved\n"
        f"KE,maize,USD/t,USD,300,400,500,2020-2024,{SRC}\n", encoding="utf-8")
    (tmp_path / "market_prices.csv").write_text(
        "region_key,crop_id,unit,currency,low,typical,high,years,price_type,markets,source_title,source_url,locator,retrieved,origin\n"
        f"KE,maize,KES/kg,KES,40,50,55,\"2023,2024,2025\",wholesale,4,{SRC},verified_source\n"
        f"KE,dry_beans,KES/kg,KES,,110,,2025,retail,2,{SRC},verified_source\n"
        f"KE,sorghum,KES/kg,KES,60,70,80,2025,street,2,{SRC},verified_source\n", encoding="utf-8")
    (tmp_path / "exchange_rates.csv").write_text(
        "currency,year,per_usd,source_title,source_url,locator,retrieved\n"
        f"USD,2024,1,{SRC}\nUSD,2025,1,{SRC}\nKES,2024,135,{SRC}\nKES,2025,130,{SRC}\n"
        f"INR,2024,84,{SRC}\nXXX,2025,-3,{SRC}\n", encoding="utf-8")


@pytest.fixture()
def tables(tmp_path, monkeypatch):
    _tables(tmp_path)
    monkeypatch.setenv("ACRE_ECONOMICS_DIR", str(tmp_path))
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    data.clear_cache()
    fx.clear_cache()
    yield
    data.clear_cache()
    fx.clear_cache()


def crop(out, cid):
    return next(c for c in out["crops"] if c["crop_id"] == cid)


def test_rates_go_through_the_dollar_using_the_latest_year_both_have(tables):
    r = fx.rate("USD", "KES")
    assert r["rate"] == 130 and r["year"] == 2025 and r["source"]["url"].startswith("https://")
    assert fx.rate("KES", "USD")["rate"] == pytest.approx(1 / 130)
    cross = fx.rate("INR", "KES")  # INR stops in 2024, so 2024 is used for both
    assert cross["year"] == 2024 and cross["rate"] == pytest.approx(135 / 84)
    assert fx.rate("KES", "KES") is None and fx.rate("USD", "ZZZ") is None
    assert not fx.known("XXX")  # a bad rate is never loaded
    assert fx.known("kes") and not fx.known(None)


def test_a_sourced_price_is_also_given_in_the_growers_currency_beside_the_original(tables):
    out = estimate_economics(KITALE, ["maize"], None, [], {}, currency="KES")
    p = crop(out, "maize")["price"]
    assert (p["typical"], p["unit"], p["origin"]) == (400, "USD/t", "verified_source")  # unchanged
    c = p["converted"]
    assert (c["low"], c["typical"], c["high"], c["unit"]) == (39000, 52000, 65000, "KES/t")
    assert c["origin"] == "calculation" and c["rate"] == {"value": 130, "from": "USD", "to": "KES",
                                                          "year": 2025}  # fmt: skip
    assert "2025 average exchange rate" in c["note"] and c["source"]["title"] == "SYNTHETIC"
    assert out["display_currency"] == {"currency": "KES", "rates_known": True}
    # no currency asked for, the same currency, or one with no rate: nothing is converted
    assert "converted" not in crop(estimate_economics(KITALE, ["maize"]), "maize")["price"]
    assert "converted" not in crop(estimate_economics(KITALE, ["maize"], currency="USD"), "maize")["price"]
    none = estimate_economics(KITALE, ["maize"], currency="TZS")
    assert "converted" not in crop(none, "maize")["price"]
    assert none["display_currency"] == {"currency": "TZS", "rates_known": False}
    # the grower's own price is never converted
    own = estimate_economics(KITALE, ["maize"], None, [],
                             {"maize": {"price": {"value": 300, "unit": "USD/t"}}}, currency="KES")  # fmt: skip
    assert "converted" not in crop(own, "maize")["price"]
    with pytest.raises(EconomicsInputError):
        estimate_economics(KITALE, ["maize"], currency="shillings")


def test_the_town_market_price_is_shown_beside_the_crop_price_and_never_used_as_it(tables):
    out = estimate_economics(KITALE, ["maize", "dry_beans", "sorghum"], None, [], {}, currency="KES")
    m = crop(out, "maize")["market_price"]
    assert (m["low"], m["typical"], m["high"], m["unit"]) == (40000, 50000, 55000, "KES/t")
    assert m["price_type"] == "wholesale" and m["markets"] == 4 and m["years"] == "2023,2024,2025"
    assert "farm gate is usually lower" in m["note"] and "converted" not in m  # already in KES
    assert crop(out, "maize")["price"]["typical"] == 400  # the producer price is still the price
    beans = crop(out, "dry_beans")
    assert beans["price"] is None and beans["market_price"]["price_type"] == "retail"
    assert beans["status"] != "complete"  # a market price alone gives no money result
    assert "shoppers" in beans["market_price"]["note"]
    assert crop(out, "sorghum")["market_price"] is None  # a row with an unknown price type is dropped
    usd = crop(estimate_economics(KITALE, ["maize"], currency="USD"), "maize")["market_price"]
    assert usd["converted"]["unit"] == "USD/t" and usd["converted"]["typical"] == pytest.approx(384.62, abs=0.01)


def test_a_market_sells_wheat_whatever_season_it_was_sown(tables, tmp_path):
    with (tmp_path / "market_prices.csv").open("a", encoding="utf-8") as f:
        f.write(f"KE,wheat_all,KES/kg,KES,,60,,2025,retail,3,{SRC},verified_source\n")
    data.clear_cache()
    out = estimate_economics(KITALE, ["winter_wheat", "spring_wheat"], currency="KES")
    assert crop(out, "winter_wheat")["market_price"]["typical"] == 60000
    assert crop(out, "spring_wheat")["market_price"]["price_type"] == "retail"
    assert crop(out, "winter_wheat")["price"] is None  # the producer price is not borrowed


def test_the_route_takes_a_currency(tables):
    c = TestClient(create_app())
    body = {"location": KITALE, "crops": ["maize"], "currency": "KES"}
    doc = c.post("/v1/economics/estimate", json=body).json()
    assert doc["crops"][0]["price"]["converted"]["unit"] == "KES/t"
    assert c.post("/v1/economics/estimate", json={**body, "currency": "Kenyan shillings"}).status_code == 400


def test_the_real_tables_load_with_no_dropped_rows():
    t = data.load(REAL)
    assert [i for i in t.issues if i["file"] == "market_prices.csv"] == []
    assert len(t.market_prices) >= 60
    assert {"KE", "ET", "TZ", "NG", "IN"} <= {r["region_key"] for r in t.market_prices}
    for r in t.market_prices:
        assert r["unit"].endswith("/kg") and r["price_type"] in {"wholesale", "retail"}
        assert "not farm-gate" in r["source_title"] and r["source_url"].startswith("https://data.humdata.org/")
    rates = fx._load(str(REAL))
    assert {"KES", "ETB", "INR", "XOF", "USD", "EUR"} <= set(rates)
    assert 100 < rates["KES"][max(rates["KES"])]["per_usd"] < 200


def test_the_import_keeps_only_the_raw_crop_and_weights():
    spec = importlib.util.spec_from_file_location("import_market", REAL / "import_market.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    assert m.crop_of("Maize (white, dry)") == "maize" and m.crop_of("Beans (rosecoco)") == "dry_beans"
    assert m.crop_of("Groundnuts (unshelled)") == "groundnut" and m.crop_of("Rice (paddy)") == "rice"
    assert m.crop_of("Potatoes (Irish, white)") == "potato" and m.crop_of("Teff (white)") == "teff"
    for processed in ("Maize flour", "Maize meal (white)", "Rice (aromatic)", "Rice", "Wheat flour",
                      "Groundnuts (shelled)", "Beans (green, fresh)", "Cassava flour", "Oil (vegetable)",
                      "Maize (imported)", "Bread", "Sugar"):  # fmt: skip
        assert m.crop_of(processed) is None, processed
    assert m.kilos("90 KG") == 90 and m.kilos("KG") == 1 and m.kilos("500 G") == 0.5 and m.kilos("MT") == 1000
    assert m.kilos("Bunch") is None and m.kilos("L") is None and m.kilos("Unit") is None
