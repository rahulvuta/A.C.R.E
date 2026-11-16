"""Build ``market_prices.csv`` and ``exchange_rates.csv`` (card 29).

Two public sources, kept apart from the producer prices in ``prices.csv``:

* **WFP food prices** (World Food Programme, on the Humanitarian Data Exchange, CC BY-IGO): the
  prices paid in town markets, in local currency. Rows are used only for the raw crop as
  harvested (grain, dry pulses, tubers; never flour, meal or milled rice) and only where the unit
  is a weight. Wholesale prices (what a trader pays) are used where a country has them; where
  it has only retail prices (what a shopper pays), those are used and labelled as retail.
  Neither is the farm-gate price, and every row says which it is.
* **World Bank** official exchange rate (indicator ``PA.NUS.FCRF``, local currency per US dollar,
  yearly average).

Without arguments the two CSVs are rebuilt from the committed extracts in ``sources/`` (no
network). With ``--refresh <cache dir>`` the original files are downloaded into that directory
first (existing files there are reused), the extracts are rewritten, and
``sources/market_manifest.json`` records each download's URL, size and SHA-256.

Selection, the same for every country: the three most recent complete calendar years with
observations of that price type, no later than ``LAST_YEAR``. One national figure per year is the
median of every observation of that type that year, per kilogram. ``typical`` is the latest year's median;
``low`` and ``high`` are the lowest and highest of the yearly medians. Nothing is converted
between currencies and nothing is adjusted for inflation; the years are in every locator.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import statistics
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RETRIEVED = "2026-11-16"
LAST_YEAR = 2025
YEARS_KEPT = 3
MIN_OBS = 6  # observations of one price type in a year for that year to count
HDX = "https://data.humdata.org/dataset/{dataset}/resource/{resource}/download/wfp_food_prices_{iso3}.csv"
# country: (ISO 3166 alpha-2, ISO alpha-3, HDX dataset id, HDX resource id)
COUNTRIES = {
    "Kenya": ("KE", "ken", "e0d3fba6-f9a2-45d7-b949-140c455197ff", "517ee1bf-2437-4f8c-aa1b-cb9925b9d437"),
    "Ethiopia": ("ET", "eth", "2e4f1922-e446-4b57-a98a-d0e2d5e34afa", "87bac18e-f3aa-4b29-8cf8-76763e823dc5"),
    "Nigeria": ("NG", "nga", "42db041f-7aaf-4ab4-961f-2a12096861e7", "12b51155-0cd3-4806-9924-61ede4077591"),
    "India": ("IN", "ind", "dc663585-4b6f-46ae-a6d6-b2f3e4ea32b5", "3b1ff071-6b01-4998-aa62-2f3efb5d4888"),
    "United Republic of Tanzania": ("TZ", "tza", "5090d858-a300-49fe-a953-4ec4e3526fc2", "2ff38c1a-a8f7-45b2-9209-090200c859da"),
    "Uganda": ("UG", "uga", "883929b1-521e-4834-97f5-0ccc2df75b89", "e082d683-cad5-4dcd-bf54-db76ae254d33"),
    "Ghana": ("GH", "gha", "626e809c-c4fc-467b-a60c-129acb5e9320", "e877350b-146f-4fa7-8690-db9605eea78c"),
    "Malawi": ("MW", "mwi", "75ecb747-717e-4ce5-b7af-0e13cc95ba63", "da3ed5da-d6ad-4a86-b4bc-b77e74d01ab7"),
    "Mozambique": ("MZ", "moz", "477a46ed-4c31-42e4-b591-a598f7ab5fe6", "e673f685-0ea4-440d-afee-76c0f1293fc0"),
    "Zambia": ("ZM", "zmb", "3f74001c-3554-4c54-bd86-c66208563316", "d9a34dc4-ff1d-43bf-9592-03d12d027848"),
    "Bangladesh": ("BD", "bgd", "c76eabb7-fdb5-43b7-a5c4-09091bb8acde", "966ab7ac-56d6-4dac-8eba-dfe815d59a52"),
    "Pakistan": ("PK", "pak", "125455ff-c8a8-4f4b-9190-bf0e84559dc7", "8cf7a8a2-58a1-4c3f-bafe-f38af68d971b"),
    "Nepal": ("NP", "npl", "0e8b1b84-8e55-4aec-bc45-0c7d2c92d32e", "10bae3d7-82bf-4caf-a216-5fb4a8ff6e43"),
    "Senegal": ("SN", "sen", "77b76bc7-1edd-43f6-a5e4-784498ff6aca", "04ffc070-6d05-4653-a9f6-9f3f893a229e"),
    "Mali": ("ML", "mli", "d73f8595-0b0b-4b64-91b3-986b1cad5ae6", "e7489e71-2c7b-48d4-8ae7-f378b735dcba"),
    "Burkina Faso": ("BF", "bfa", "bfd82e1f-0296-48a8-ac28-c11e028be5ed", "0eca67d6-e297-4f5e-9132-7dc42891b749"),
    "Niger": ("NE", "ner", "9c2f8da3-c0a5-476d-9035-b9b59172b922", "87334563-5dae-4125-9bcc-e9418283a8c9"),
    "Cameroon": ("CM", "cmr", "f6ed9f06-36b9-43b2-97f3-fc0b8e16d155", "9deec824-1e42-4a91-b704-b73fd250ec5a"),
}  # fmt: skip
WFP_PAGE = "https://data.humdata.org/dataset/{dataset}"
WB_URL = ("https://api.worldbank.org/v2/country/all/indicator/PA.NUS.FCRF"
          "?format=json&date=2020:2025&per_page=20000")  # fmt: skip
WB_PAGE = "https://data.worldbank.org/indicator/PA.NUS.FCRF"
# The currency each World Bank country uses (ISO 3166 alpha-3 -> ISO 4217). A country not listed
# here gets no exchange-rate row; nothing is guessed.
CURRENCY_OF = {
    "KEN": "KES", "ETH": "ETB", "NGA": "NGN", "IND": "INR", "TZA": "TZS", "UGA": "UGX", "GHA": "GHS",
    "MWI": "MWK", "MOZ": "MZN", "ZMB": "ZMW", "RWA": "RWF", "BGD": "BDT", "PAK": "PKR", "NPL": "NPR",
    "PHL": "PHP", "IDN": "IDR", "VNM": "VND", "THA": "THB", "LKA": "LKR", "MMR": "MMK", "KHM": "KHR",
    "SEN": "XOF", "MLI": "XOF", "BFA": "XOF", "NER": "XOF", "CIV": "XOF", "BEN": "XOF", "TGO": "XOF",
    "CMR": "XAF", "TCD": "XAF", "ZAF": "ZAR", "EGY": "EGP", "MAR": "MAD", "TUN": "TND", "DZA": "DZD",
    "SDN": "SDG", "BRA": "BRL", "ARG": "ARS", "MEX": "MXN", "COL": "COP", "PER": "PEN", "CHL": "CLP",
    "BOL": "BOB", "PRY": "PYG", "URY": "UYU", "CAN": "CAD", "AUS": "AUD", "NZL": "NZD", "GBR": "GBP",
    "CHE": "CHF", "SWE": "SEK", "NOR": "NOK", "DNK": "DKK", "POL": "PLN", "CZE": "CZK", "HUN": "HUF",
    "ROU": "RON", "UKR": "UAH", "TUR": "TRY", "RUS": "RUB", "KAZ": "KZT", "UZB": "UZS", "CHN": "CNY",
    "JPN": "JPY", "KOR": "KRW", "MYS": "MYR", "SAU": "SAR", "IRN": "IRR", "IRQ": "IQD", "ISR": "ILS",
    "EMU": "EUR",
}  # fmt: skip

# The raw crop as harvested. A commodity that matches a SKIP word is never a crop price.
SKIP = re.compile(r"flour|meal|milled|polished|parboiled|imported|bread|pasta|noodle|oil|fresh|green|"
                  r"shelled|paste|biscuit|split|gari|chips|starch|seed|aromatic|basmati|broken", re.I)  # fmt: skip
CROPS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^maize\b", re.I), "maize"),
    (re.compile(r"^sorghum\b", re.I), "sorghum"),
    (re.compile(r"^millet\b", re.I), "millet"),
    (re.compile(r"^rice \(paddy", re.I), "rice"),
    (re.compile(r"^wheat\b", re.I), "wheat_all"),
    (re.compile(r"^barley\b", re.I), "barley_all"),
    (re.compile(r"^teff\b", re.I), "teff"),
    (re.compile(r"^(cowpeas?|beans \(niebe)", re.I), "cowpea"),
    (re.compile(r"^chickpeas?\b", re.I), "chickpea"),
    (re.compile(r"^lentils?\b", re.I), "lentil"),
    (re.compile(r"^pigeon peas?\b", re.I), "pigeon_pea"),
    (re.compile(r"^beans \((fava|broad)", re.I), "broad_bean"),
    (re.compile(r"^beans\b(?! \((mung|soy|string|haricot vert))", re.I), "dry_beans"),
    (re.compile(r"^soybeans?\b", re.I), "soybean"),
    (re.compile(r"^groundnuts? \(unshelled", re.I), "groundnut"),
    (re.compile(r"^sweet potatoes?\b", re.I), "sweet_potato"),
    (re.compile(r"^potatoes?\b", re.I), "potato"),
    (re.compile(r"^cassava$", re.I), "cassava"),
    (re.compile(r"^yam\b", re.I), "yam"),
    (re.compile(r"^sesame\b", re.I), "sesame"),
]
WEIGHT = re.compile(r"^(?:(\d+(?:\.\d+)?)\s*)?(KG|G|MT)$", re.I)


def crop_of(commodity: str) -> str | None:
    """The crop a market commodity is, or None when it is processed, mixed or not a field crop."""
    name = commodity.strip()
    # "Groundnuts (unshelled)" holds the skip word "shelled"; it is the raw crop.
    if SKIP.search(name) and not re.match(r"^groundnuts? \(unshelled", name, re.I):
        return None
    for pattern, crop in CROPS:
        if pattern.search(name):
            return crop
    return None


def kilos(unit: str) -> float | None:
    """Kilograms in one WFP unit ("KG", "90 KG", "500 G", "MT"); None for a bunch, a litre, a piece."""
    m = WEIGHT.match(unit.strip())
    if not m:
        return None
    n = float(m.group(1) or 1)
    per = {"KG": 1.0, "G": 0.001, "MT": 1000.0}[m.group(2).upper()]
    return n * per if n > 0 else None


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str, path: Path) -> bytes:
    if not path.exists():
        req = urllib.request.Request(url, headers={"User-Agent": "acre-economics-import"})
        with urllib.request.urlopen(req, timeout=300) as r:  # noqa: S310 - fixed https URLs above
            path.write_bytes(r.read())
    return path.read_bytes()


# --------------------------------------------------------------------------- extraction


def extract_wfp(country: str, body: bytes) -> list[dict[str, str]]:
    """One row per crop and year: the national median wholesale price per kilogram."""
    iso2 = COUNTRIES[country][0]
    per: dict[tuple[str, str, int, str], list[float]] = defaultdict(list)
    markets: dict[tuple[str, str, int, str], set[str]] = defaultdict(set)
    names: dict[tuple[str, str, int, str], set[str]] = defaultdict(set)
    for r in csv.DictReader(body.decode("utf-8-sig").splitlines()):
        date = r.get("date") or ""
        kind = (r.get("pricetype") or "").strip().lower()
        if date.startswith("#") or kind not in ("wholesale", "retail"):
            continue
        crop = crop_of(r.get("commodity") or "")
        kg = kilos(r.get("unit") or "")
        try:
            price, year = float(r["price"]), int(date[:4])
        except (KeyError, ValueError):
            continue
        cur = (r.get("currency") or "").strip().upper()
        if crop is None or kg is None or price <= 0 or len(cur) != 3 or year > LAST_YEAR:
            continue
        key = (crop, cur, year, kind)
        per[key].append(price / kg)
        markets[key].add(r.get("market") or "")
        names[key].add((r.get("commodity") or "").strip())
    return [{"region_key": iso2, "country": country, "crop_id": crop, "currency": cur, "year": str(year),
             "price_type": kind, "median_per_kg": f"{statistics.median(v):.4f}",
             "observations": str(len(v)), "markets": str(len(markets[(crop, cur, year, kind)])),
             "commodities": "; ".join(sorted(names[(crop, cur, year, kind)]))}
            for (crop, cur, year, kind), v in sorted(per.items()) if len(v) >= MIN_OBS]  # fmt: skip


def extract_fx(body: bytes) -> list[dict[str, str]]:
    doc = json.loads(body)
    out = []
    for r in doc[1] if isinstance(doc, list) and len(doc) > 1 else []:
        iso3, value = r.get("countryiso3code"), r.get("value")
        cur = CURRENCY_OF.get(iso3 or "")
        if cur and isinstance(value, int | float) and value > 0:
            out.append({"currency": cur, "year": str(r["date"]), "per_usd": f"{value:.6g}",
                        "country": r["country"]["value"], "iso3": iso3})  # fmt: skip
    return sorted(out, key=lambda r: (r["currency"], r["year"], r["iso3"]))


# --------------------------------------------------------------------------- the two tables

MARKET_FIELDS = ["region_key", "crop_id", "unit", "currency", "low", "typical", "high", "years",
                 "price_type", "markets", "source_title", "source_url", "locator", "retrieved",
                 "origin"]  # fmt: skip
FX_FIELDS = ["currency", "year", "per_usd", "source_title", "source_url", "locator", "retrieved"]


def build_market(annual: list[dict[str, str]]) -> list[dict[str, str]]:
    by: dict[tuple[str, str, str, str], list[dict[str, str]]] = defaultdict(list)
    for r in annual:
        by[(r["region_key"], r["crop_id"], r["currency"], r["price_type"])].append(r)
    dataset = {v[0]: v[2] for v in COUNTRIES.values()}
    out = []
    for (region, crop, cur, kind), rows in sorted(by.items()):
        rows = sorted(rows, key=lambda r: int(r["year"]))[-YEARS_KEPT:]
        if int(rows[-1]["year"]) < LAST_YEAR - 2:  # nothing recent: an old price is not a reference
            continue
        # Retail is used only where the country has no recent wholesale price for the crop.
        if kind == "retail" and any(int(r["year"]) >= LAST_YEAR - 2
                                    for r in by.get((region, crop, cur, "wholesale"), [])):
            continue
        vals = [float(r["median_per_kg"]) for r in rows]
        several = len(rows) > 1
        detail = "; ".join(f"{r['year']}={float(r['median_per_kg']):g} ({r['observations']} "
                           f"observations, {r['markets']} markets)" for r in rows)  # fmt: skip
        out.append({
            "region_key": region, "crop_id": crop, "unit": f"{cur}/kg", "currency": cur,
            "low": f"{min(vals):g}" if several else "", "typical": f"{vals[-1]:g}",
            "high": f"{max(vals):g}" if several else "",
            "years": ",".join(r["year"] for r in rows), "price_type": kind,
            "markets": rows[-1]["markets"],
            "source_title": f"WFP food prices, {kind} (town markets, not farm-gate)",
            "source_url": WFP_PAGE.format(dataset=dataset[region]),
            "locator": (f"Country={rows[0]['country']}; pricetype={kind.capitalize()}; commodities: "
                        f"{rows[-1]['commodities']}; per kilogram from the listed weight unit; "
                        f"national median of all observations in each year; typical=latest year, "
                        f"low/high=lowest/highest yearly median; {detail}"),
            "retrieved": RETRIEVED, "origin": "verified_source"})  # fmt: skip
    return out


def build_fx(extract: list[dict[str, str]]) -> list[dict[str, str]]:
    """One rate per currency and year. A currency shared by several countries (XOF, XAF) has one
    value per year in the source; the first country in ISO order names the row."""
    seen: set[tuple[str, str]] = set()
    out = [{"currency": "USD", "year": str(y), "per_usd": "1", "source_title": "By definition",
            "source_url": WB_PAGE, "locator": "US dollar per US dollar", "retrieved": RETRIEVED}
           for y in range(2020, LAST_YEAR + 1)]  # fmt: skip
    for r in extract:
        key = (r["currency"], r["year"])
        if key in seen:
            continue
        seen.add(key)
        out.append({"currency": r["currency"], "year": r["year"], "per_usd": r["per_usd"],
                    "source_title": "World Bank, official exchange rate (yearly average)",
                    "source_url": WB_PAGE,
                    "locator": f"Indicator PA.NUS.FCRF; {r['country']} ({r['iso3']}); "
                               f"local currency units per US dollar, period average, {r['year']}",
                    "retrieved": RETRIEVED})  # fmt: skip
    return sorted(out, key=lambda r: (r["currency"], r["year"]))


def write(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def read(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", metavar="CACHE_DIR", help="download the originals into this directory first")
    args = ap.parse_args()
    sources = ROOT / "sources"
    annual_path, fx_path = sources / "wfp_wholesale_annual.csv", sources / "worldbank_fx.csv"
    if args.refresh:
        cache = Path(args.refresh)
        cache.mkdir(parents=True, exist_ok=True)
        manifest: dict[str, dict[str, object]] = {}
        annual: list[dict[str, str]] = []
        for country, (_iso2, iso3, dataset, resource) in COUNTRIES.items():
            url = HDX.format(dataset=dataset, resource=resource, iso3=iso3)
            body = download(url, cache / f"wfp_food_prices_{iso3}.csv")
            manifest[f"wfp_food_prices_{iso3}.csv"] = {"url": url, "sha256": sha256(body), "bytes": len(body),
                                                      "retrieved": RETRIEVED, "license": "CC BY-IGO"}  # fmt: skip
            annual += extract_wfp(country, body)
        fx_body = download(WB_URL, cache / "worldbank_fx.json")
        manifest["worldbank_fx.json"] = {"url": WB_URL, "sha256": sha256(fx_body), "bytes": len(fx_body),
                                         "retrieved": RETRIEVED, "license": "CC BY 4.0"}  # fmt: skip
        write(annual_path, ["region_key", "country", "crop_id", "currency", "year", "price_type",
                            "median_per_kg", "observations", "markets", "commodities"], annual)  # fmt: skip
        write(fx_path, ["currency", "year", "per_usd", "country", "iso3"], extract_fx(fx_body))
        (sources / "market_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    market = build_market(read(annual_path))
    fx = build_fx(read(fx_path))
    write(ROOT / "market_prices.csv", MARKET_FIELDS, market)
    write(ROOT / "exchange_rates.csv", FX_FIELDS, fx)
    countries = sorted({r["region_key"] for r in market})
    print(f"market_prices.csv: {len(market)} rows in {len(countries)} countries ({', '.join(countries)})")
    print(f"exchange_rates.csv: {len(fx)} rows, {len({r['currency'] for r in fx})} currencies")


if __name__ == "__main__":
    main()
