"""Rebuild E0 tables from checked source extracts; optionally refresh upstream files."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import statistics
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RETRIEVED = "2026-11-15"
COUNTRIES = {
    "Argentina": "AR",
    "Brazil": "BR",
    "India": "IN",
    "France": "FR",
    "United States of America": "US",
    "China, mainland": "CN",
    "Nigeria": "NG",
    "Kenya": "KE",
    "Australia": "AU",
    "Mexico": "MX",
}
# Keep all-season aggregates distinct from season-specific catalog crops.
ITEMS = {
    "15": "wheat_all",
    "27": "rice",
    "56": "maize",
    "83": "sorghum",
    "236": "soybean",
    "116": "potato",
    "125": "cassava",
    "156": "sugarcane",
    "157": "sugarbeet",
    "242": "groundnut",
    "767": "cotton_lint",
    "328": "seed_cotton",
    "122": "sweet_potato",
    "44": "barley_all",
    "79": "millet",
    "71": "rye_all",
    "101": "canary_seed",
    "75": "oats_all",
    "187": "dry_pea",
    "197": "pigeon_pea",
    "195": "cowpea",
    "181": "broad_bean",
    "201": "lentil",
    "176": "dry_beans",
    "191": "chickpea",
    "203": "bambara_groundnut",
    "267": "sunflower",
    "270": "rapeseed_all",
    "137": "yam",
}
URLS = {
    "faostat_prices.zip": "https://bulks-faostat.fao.org/production/Prices_E_All_Data_(Normalized).zip",
    "faostat_crops.zip": "https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_All_Data_(Normalized).zip",
    "nass_crop.pdf": "https://esmis.nal.usda.gov/sites/default/release-files/k3569432s/nk324887m/qn59s0097/cropan25.pdf",
    "nass_prices.pdf": "https://release.nass.usda.gov/reports/agpr0725.pdf",
    "iowa.pdf": "https://www.extension.iastate.edu/agdm/crops/pdf/a3-10.pdf",
    **{
        f"ers_{c}.csv": f"https://www.ers.usda.gov/media/{n}/{c}.csv"
        for c, n in [
            ("corn", 4962),
            ("cotton", 4964),
            ("barley", 4966),
            ("peanuts", 4968),
            ("rice", 4970),
            ("sorghum", 4972),
            ("oats", 4974),
            ("soybeans", 4976),
            ("wheat", 4978),
        ]
    },
}
SOURCE_COLS = ["source_title", "source_url", "locator", "retrieved", "origin"]
FIELDS = {
    "prices": [
        "region_key",
        "crop_id",
        "unit",
        "currency",
        "low",
        "typical",
        "high",
        "years",
    ],
    "yields": ["region_key", "crop_id", "value", "unit", "year", "area_basis"],
    "costs": [
        "region_key",
        "crop_id",
        "item",
        "value",
        "unit",
        "currency",
        "year",
        "area_basis",
    ],
    "custom_rates": [
        "region_key",
        "operation",
        "equipment",
        "value",
        "unit",
        "currency",
        "year",
    ],
}
STATES = {
    "Alabama": "AL",
    "Alaska": "AK",
    "Arizona": "AZ",
    "Arkansas": "AR",
    "California": "CA",
    "Colorado": "CO",
    "Connecticut": "CT",
    "Delaware": "DE",
    "Florida": "FL",
    "Georgia": "GA",
    "Hawaii": "HI",
    "Idaho": "ID",
    "Illinois": "IL",
    "Indiana": "IN",
    "Iowa": "IA",
    "Kansas": "KS",
    "Kentucky": "KY",
    "Louisiana": "LA",
    "Maine": "ME",
    "Maryland": "MD",
    "Massachusetts": "MA",
    "Michigan": "MI",
    "Minnesota": "MN",
    "Mississippi": "MS",
    "Missouri": "MO",
    "Montana": "MT",
    "Nebraska": "NE",
    "Nevada": "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    "Ohio": "OH",
    "Oklahoma": "OK",
    "Oregon": "OR",
    "Pennsylvania": "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    "Tennessee": "TN",
    "Texas": "TX",
    "Utah": "UT",
    "Vermont": "VT",
    "Virginia": "VA",
    "Washington": "WA",
    "West Virginia": "WV",
    "Wisconsin": "WI",
    "Wyoming": "WY",
}


def read(path):
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def write(path, rows, fields):
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def refresh(cache):
    import pdfplumber  # optional dependency only needed for source refresh

    pinned = (
        json.loads((ROOT / "sources" / "manifest.json").read_text())
        if (ROOT / "sources" / "manifest.json").exists()
        else {}
    )
    manifest = {}
    for name, url in URLS.items():
        path = cache / name
        if not path.exists():
            urllib.request.urlretrieve(url, path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if name in pinned and digest != pinned[name]["sha256"]:
            raise ValueError(
                f"Upstream revision in {name}; review and repin before importing"
            )
        manifest[name] = {
            "url": url,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size,
            "retrieved": RETRIEVED,
        }
    (ROOT / "sources" / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    for name in ["faostat_prices", "faostat_crops"]:
        z = zipfile.ZipFile(cache / (name + ".zip"))
        raw = csv.DictReader(
            io.TextIOWrapper(z.open(z.namelist()[0]), encoding="utf-8-sig")
        )
        rows = [
            r
            for r in raw
            if r["Area"] in COUNTRIES
            and r["Item Code"] in ITEMS
            and 2020 <= int(r["Year"]) <= 2024
            and r["Element Code"] in {"5532", "5412", "5510"}
            and (name != "faostat_prices" or r["Months Code"] == "7021")
        ]
        write(ROOT / "sources" / (name + ".csv"), rows, raw.fieldnames)
    for crop in [
        "corn",
        "cotton",
        "barley",
        "peanuts",
        "rice",
        "sorghum",
        "oats",
        "soybeans",
        "wheat",
    ]:
        rows = [
            r
            for r in read(cache / f"ers_{crop}.csv")
            if r["Region"] == "U.S. total" and r["Year"] == "2024"
        ]
        write(ROOT / "sources" / f"ers_{crop}.csv", rows, list(rows[0]))
    with pdfplumber.open(cache / "nass_crop.pdf") as pdf:
        rows = []
        for page, crop, unit in [
            (10, "maize", "bu/acre"),
            (17, "sorghum", "bu/acre"),
            (20, "oats_all", "bu/acre"),
            (22, "barley_all", "bu/acre"),
            (24, "wheat_all", "bu/acre"),
            (26, "winter_wheat", "bu/acre"),
            (27, "spring_wheat", "bu/acre"),
            (46, "groundnut", "lb/acre"),
            (47, "canola_all", "lb/acre"),
            (51, "soybean", "bu/acre"),
            (30, "rice", "lb/acre"),
            (49, "sunflower", "lb/acre"),
            (62, "cotton_all", "lb/acre"),
            (62, "cotton_upland", "lb/acre"),
        ]:
            text = pdf.pages[page - 1].extract_text()
            text = text.split("Yield per acre", 1)[1]
            if page in {30, 49} or crop == "cotton_all":
                text = text.split("\nAll\n", 1)[1]
            elif crop == "cotton_upland":
                text = text.split("\nUpland\n", 1)[1].split("\nAmerican Pima\n", 1)[0]
            for line in text.splitlines():
                match = re.match(r"([A-Za-z ]+?)(?:\s+[12])?\s*\.{2,}\s+(.+)$", line)
                if not match:
                    continue
                state = match[1].strip()
                vals = match[2].split()
                if len(vals) != 6 or state not in STATES and state != "United States":
                    continue
                if vals[2].startswith("("):
                    continue
                rows.append(
                    {
                        "region_key": "US"
                        if state == "United States"
                        else "US-" + STATES[state],
                        "crop_id": crop,
                        "value": vals[2].replace(",", ""),
                        "unit": unit,
                        "year": "2024",
                        "page": page,
                        "state": state,
                        "source_line": line,
                    }
                )
        write(ROOT / "sources" / "nass_yields.csv", rows, list(rows[0]))
    with pdfplumber.open(cache / "nass_prices.pdf") as pdf:
        rows = []
        mapping = {
            "Corn": ("maize", "USD/bu"),
            "Cotton, Upland": ("cotton_upland", "USD/lb"),
            "All wheat": ("wheat_all", "USD/bu"),
            "Peanuts": ("groundnut", "USD/lb"),
            "Rice": ("rice", "USD/cwt"),
            "All barley": ("barley_all", "USD/bu"),
            "Oats": ("oats_all", "USD/bu"),
            "Sorghum": ("sorghum", "USD/cwt"),
            "Soybeans": ("soybean", "USD/bu"),
            "All sunflower": ("sunflower", "USD/cwt"),
        }
        for page, years, indexes in [
            (43, [2020, 2021], [5, 6]),
            (44, [2022, 2023, 2024], [0, 1, 2]),
        ]:
            for line in pdf.pages[page - 1].extract_text().splitlines():
                for label, (crop, unit) in mapping.items():
                    if re.match(re.escape(label) + r"\s*\.", line):
                        nums = re.findall(r"\d+(?:\.\d+)?", line.split("..")[-1])
                        for position, year in enumerate(years):
                            index = indexes[position]
                            rows.append(
                                {
                                    "crop_id": crop,
                                    "unit": unit,
                                    "year": year,
                                    "value": nums[index],
                                    "page": page,
                                    "source_line": line,
                                }
                            )
        assert len(rows) == 50, len(rows)
        write(ROOT / "sources" / "nass_prices.csv", rows, list(rows[0]))
    with pdfplumber.open(cache / "iowa.pdf") as pdf:
        assert "2026 Iowa" in pdf.pages[0].extract_text(), (
            "Upstream survey edition changed; review before refresh"
        )
        rows = []
        mapping = {
            2: {
                "Chisel plowing / acre": ("chisel_plow", "chisel_plowing"),
                "Disking, tandem / acre": ("disk", "disking_tandem"),
                "Field cultivating / acre": ("field_cultivator", "field_cultivating"),
                "-without attachments / acre": (
                    "planter",
                    "planting_without_attachments",
                ),
                "Drilling small grain / acre": ("grain_drill", "drilling_small_grain"),
                "Drilling soybean, no-till / acre": (
                    "no_till_drill",
                    "drilling_soybean_no_till",
                ),
                "Drilling cover crop seed / acre": (
                    "grain_drill",
                    "drilling_cover_crop",
                ),
                "Seeding grass, broadcast with tractor / acre": (
                    "broadcast_seeder",
                    "broadcast_grass_with_tractor",
                ),
            },
            3: {
                "Ground, broadcast, not incorporated, self-propelled / acre": (
                    "sprayer",
                    "spraying_ground_broadcast_no_materials",
                ),
                "Corn combining / acre": ("combine", "corn_combining"),
                "Soybean combining / acre": ("combine", "soybean_combining"),
                "Small grain combining / acre": ("combine", "small_grain_combining"),
            },
        }
        for page, labels in mapping.items():
            for line in pdf.pages[page - 1].extract_text().splitlines():
                for label, (equipment, operation) in labels.items():
                    if line.startswith(label + " "):
                        value = re.findall(r"\d+\.\d+", line[len(label) :])[0]
                        rows.append(
                            {
                                "equipment": equipment,
                                "operation": operation,
                                "value": value,
                                "page": page,
                                "source_line": line,
                            }
                        )
        assert len(rows) == 12, len(rows)
        write(ROOT / "sources" / "iowa_rates.csv", rows, list(rows[0]))


def provenance(title, url, locator, estimated=False):
    return {
        "source_title": title,
        "source_url": url,
        "locator": locator,
        "retrieved": RETRIEVED,
        "origin": "dataset_estimate" if estimated else "verified_source",
    }


def build():
    out = {key: [] for key in FIELDS}
    grouped = {}
    for row in read(ROOT / "sources" / "nass_prices.csv"):
        grouped.setdefault((row["crop_id"], row["unit"]), []).append(row)
    for (crop, unit), rows in grouped.items():
        vals = [float(r["value"]) for r in rows]
        out["prices"].append(
            dict(
                region_key="US",
                crop_id=crop,
                unit=unit,
                currency="USD",
                low=min(vals),
                typical=statistics.median(vals),
                high=max(vals),
                years="2020-2024",
                **provenance(
                    "USDA NASS Agricultural Prices (July 2025)",
                    URLS["nass_prices.pdf"],
                    "pp.43-44; calendar-year simple averages of monthly prices (2024 preliminary); low=min, typical=median, high=max of "
                    + "; ".join(r["year"] + "=" + r["value"] for r in rows),
                ),
            )
        )
    for r in read(ROOT / "sources" / "nass_yields.csv"):
        out["yields"].append(
            {
                **{k: r[k] for k in FIELDS["yields"] if k != "area_basis"},
                "area_basis": "harvested",
                **provenance(
                    "USDA NASS Crop Production 2024 Summary (January 2025)",
                    URLS["nass_crop.pdf"],
                    f"p.{r['page']}; {r['state']}; 2024 yield per harvested acre; crop={r['crop_id']}; {r['source_line']}",
                ),
            }
        )
    for dataset in ["prices", "crops"]:
        rows = read(ROOT / "sources" / f"faostat_{dataset}.csv")
        grouped = {}
        for r in rows:
            if r["Element Code"] not in {"5532", "5412"}:
                continue
            grouped.setdefault((r["Area"], r["Item Code"]), []).append(r)
        for (country, item), rs in grouped.items():
            region, crop = COUNTRIES[country], ITEMS[item]
            if region == "US" and any(
                r["region_key"] == "US" and r["crop_id"] == crop
                for r in out["prices" if dataset == "prices" else "yields"]
            ):
                continue  # Preserve overlap in extracts; one preferred US reference per crop.
            url = URLS[f"faostat_{dataset}.zip"]
            title = (
                "FAOSTAT Producer Prices"
                if dataset == "prices"
                else "FAOSTAT Crops and livestock products"
            )
            rs = sorted(rs, key=lambda x: x["Year"])
            prefix = f"Area={country} ({rs[0]['Area Code']}); Item={rs[0]['Item']} ({item}); Element={rs[0]['Element Code']}; "
            if dataset == "prices":
                assert all(
                    r["Unit"] == "USD" and r["Months Code"] == "7021" for r in rs
                )
                values = [float(r["Value"]) for r in rs]
                years = ",".join(r["Year"] for r in rs)
                p = provenance(
                    title,
                    url,
                    prefix
                    + "annual USD/tonne; low=min, typical=median, high=max; "
                    + "; ".join(
                        f"{r['Year']}={r['Value']} (flag {r['Flag']})" for r in rs
                    ),
                    any(r["Flag"] in {"E", "I"} for r in rs),
                )
                out["prices"].append(
                    dict(
                        region_key=region,
                        crop_id=crop,
                        unit="USD/t",
                        currency="USD",
                        low=min(values) if len(values) > 1 else "",
                        typical=statistics.median(values),
                        high=max(values) if len(values) > 1 else "",
                        years=years,
                        **p,
                    )
                )
            else:
                r = rs[-1]
                assert r["Unit"] == "kg/ha", r
                out["yields"].append(
                    dict(
                        region_key=region,
                        crop_id=crop,
                        value=round(float(r["Value"]) / 1000, 6),
                        unit="t/ha",
                        year=r["Year"],
                        area_basis="harvested",
                        **provenance(
                            title,
                            url,
                            prefix
                            + f"Year={r['Year']}; source {r['Value']} kg/ha divided by 1000; flag {r['Flag']}; yield per harvested hectare",
                            r["Flag"] in {"E", "I"},
                        ),
                    )
                )
    cmap = {
        "corn": "maize",
        "cotton": "cotton_all",
        "barley": "barley_all",
        "peanuts": "groundnut",
        "rice": "rice",
        "sorghum": "sorghum",
        "oats": "oats_all",
        "soybeans": "soybean",
        "wheat": "wheat_all",
    }
    for source, crop in cmap.items():
        rows = read(ROOT / "sources" / f"ers_{source}.csv")
        rs = [
            r
            for r in rows
            if r["Category"] == "Costs listed" and r["Item"] == "Total, costs listed"
        ]
        assert len(rs) == 1
        r = rs[0]
        assert r["Units"] == "dollars per planted acre"
        out["costs"].append(
            dict(
                region_key="US",
                crop_id=crop,
                item="total_costs_listed",
                value=r["Value"],
                unit="USD/acre",
                currency="USD",
                year=r["Year"],
                area_basis="planted",
                **provenance(
                    "USDA ERS Commodity Costs and Returns: " + r["Commodity"],
                    URLS[f"ers_{source}.csv"],
                    f"Region=U.S. total; Year={r['Year']}; Category=Costs listed; Item=Total, costs listed; dollars per planted acre; {r['Survey base year']}; operating + allocated overhead costs (includes opportunity costs)",
                ),
            )
        )
    for r in read(ROOT / "sources" / "iowa_rates.csv"):
        out["custom_rates"].append(
            dict(
                region_key="US-IA",
                operation=r["operation"],
                equipment=r["equipment"],
                value=r["value"],
                unit="USD/acre",
                currency="USD",
                year=2026,
                **provenance(
                    "Iowa State University 2026 Iowa Farm Custom Rate Survey (A3-10)",
                    URLS["iowa.pdf"],
                    f"p.{r['page']}; Average Charge; {r['source_line']}; custom hire including fuel and operator labor; materials excluded for spraying",
                ),
            )
        )
    for name, rows in out.items():
        write(ROOT / (name + ".csv"), rows, FIELDS[name] + SOURCE_COLS)
    coverage = {
        key: {
            name: sum(r["region_key"] == key for r in rows)
            for name, rows in out.items()
        }
        for key in sorted(
            set(COUNTRIES.values())
            | {r["region_key"] for rows in out.values() for r in rows}
        )
    }
    (ROOT / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
    countries = sorted(COUNTRIES.values())
    gaps = {
        "window": "2020-2024",
        "missing_price_for_imported_national_yield": {
            country: sorted(
                {r["crop_id"] for r in out["yields"] if r["region_key"] == country}
                - {r["crop_id"] for r in out["prices"] if r["region_key"] == country}
            )
            for country in countries
        },
        "incomplete_price_windows": [
            {
                "region_key": r["region_key"],
                "crop_id": r["crop_id"],
                "years": r["years"],
            }
            for r in out["prices"]
            if r["years"] != "2020-2024" and len(r["years"].split(",")) < 5
        ],
        "absent_categories": [
            "non-US costs",
            "non-Iowa custom rates",
            "county yields",
            "unmapped FAOSTAT commodities",
        ],
        "source_access_failures": [
            {
                "url": "https://fenixservices.fao.org/faostat/api/v1/en/data/PP?area_code=9&element_code=5532&year=2022&item_code=56",
                "http_status": 403,
                "retrieved": RETRIEVED,
                "fallback": "official FAOSTAT bulk ZIP",
            },
            {
                "url": "https://www.nass.usda.gov/Publications/Todays_Reports/reports/cropan25.pdf",
                "http_status": 404,
                "retrieved": RETRIEVED,
                "fallback": URLS["nass_crop.pdf"],
            },
            {
                "url": "https://www.nass.usda.gov/Publications/Todays_Reports/reports/cpvl0225.pdf",
                "http_status": 404,
                "retrieved": RETRIEVED,
                "fallback": "Agricultural Prices July 2025 annual calendar-year table",
            },
            {
                "url": "https://www.nass.usda.gov/Statistics_by_State/Iowa/Publications/Annual_Statistical_Bulletin/2025-Iowa-Annual-Bulletin.pdf",
                "http_status": 404,
                "retrieved": RETRIEVED,
                "fallback": "official NASS production/prices reports plus Iowa State survey",
            },
            {
                "url": "https://data.nass.usda.gov/Statistics_by_State/North_Carolina/Publications/Annual_Statistical_Bulletin/AgStat/Section03.pdf",
                "http_status": 404,
                "retrieved": RETRIEVED,
                "fallback": "national NASS prices; no state prices substituted",
            },
        ],
    }
    (ROOT / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    print({name: len(rows) for name, rows in out.items()})


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument(
        "--refresh",
        type=Path,
        help="cache directory for upstream downloads; requires pdfplumber",
    )
    args = p.parse_args()
    if args.refresh:
        args.refresh.mkdir(parents=True, exist_ok=True)
        refresh(args.refresh)
    build()
