"""Deterministic synthetic farms and example inputs for the guided demo (S6)."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from acre.farms.geometry import parse_field
from acre.report.meta import response_meta
from acre.simulate.vocab import OUTLOOK_NOTE

LABEL = "Demo farm (example values)"
NOTE = ("Synthetic boundaries, crop dates, equipment, readings and economics for a demo, "
        "not a real farm. Money values are example inputs, not sourced references. "
        + OUTLOOK_NOTE)
UNION_ECON = {
    "soybean": {"price": {"value": 11.2, "unit": "USD/bu"},
                "yield": {"value": 48, "unit": "bu/acre"},
                "costs": {"value": 410, "unit": "USD/acre"}},
    "field_corn": {"price": {"value": 4.5, "unit": "USD/bu"},
                   "yield": {"value": 170, "unit": "bu/acre"},
                   "costs": {"value": 700, "unit": "USD/acre"}},
    "cereal_rye": {"costs": {"value": 45, "unit": "USD/acre"}},
}
PERGAMINO_ECON = {
    "soybean": {"price": {"value": 350, "unit": "USD/t"},
                "yield": {"value": 3.2, "unit": "t/ha"},
                "costs": {"value": 650, "unit": "USD/ha"}},
    "maize": {"price": {"value": 180, "unit": "USD/t"},
              "yield": {"value": 8, "unit": "t/ha"},
              "costs": {"value": 1000, "unit": "USD/ha"}},
    "cereal_rye": {"costs": {"value": 100, "unit": "USD/ha"}},
}


def _rectangle(lat: float, lon: float) -> dict[str, Any]:
    west, south = round(lon, 6), round(lat, 6)
    east, north = round(lon + 0.0044, 6), round(lat + 0.0036, 6)
    return {"type": "Polygon", "coordinates": [[[west, south], [east, south], [east, north],
                                                  [west, north], [west, south]]]}


def demo_farm(scenario: str) -> dict[str, Any]:
    union = scenario == "union"
    lat, lon = (34.98, -80.55) if union else (-33.89, -60.57)
    crops = ("field_corn", "soybean") if union else ("maize", "soybean")
    harvests = ("10-15", "10-20") if union else ("04-20", "05-01")
    plants = ("05-12", "04-20") if union else ("11-15", "10-15")
    fields, current = [], {}
    for i, suffix in enumerate(("north", "south")):
        fid = f"fld_demo_{scenario}_{suffix}"
        rotation = [{"plan_id": f"{fid}_{j}", "label": "Synthetic example crop plan",
                     "previous_crop_id": crops[j], "prev_harvest": harvests[j],
                     "next_crop_id": crops[1 - j], "next_plant": plants[j],
                     "winter": {"kind": "none"}} for j in range(2)]
        if i:
            rotation.reverse()
        geometry = _rectangle(lat + i * 0.006, lon + i * 0.007)
        fields.append({"field_id": fid, "name": f"{suffix.title()} field (synthetic)",
                       "geometry": geometry, "plan": rotation[0],
                       "area_ha": round(parse_field(geometry).area_ha, 3),
                       "area_origin": "calculation", "origin": "assumed",
                       "equipment": ["planter", "grain_drill", "sprayer", "combine"],
                       "readings": [{"date": "2025-04-02" if union else "2025-10-02",
                                     "kind": "soil_moisture_pct", "value": 23.5 + i,
                                     "depth_cm": 10, "note": "Synthetic demo reading",
                                     "origin": "assumed"}],
                       "location": {"latitude": round(lat + i * 0.006 + 0.0018, 6),
                                    "longitude": round(lon + i * 0.007 + 0.0022, 6)}})
        current[fid] = rotation
    return {"meta": response_meta(weather=False), "status": "complete", "label": LABEL,
            "synthetic": True, "origin": "assumed", "note": NOTE,
            "farm": {"farm_id": f"farm_demo_{scenario}",
                     "name": ("Union County" if union else "Pergamino") + " demo farm (synthetic)",
                     "anchor": {"latitude": lat, "longitude": lon}, "fields": fields},
            "current_plans": current,
            "economics_overrides": deepcopy(UNION_ECON if union else PERGAMINO_ECON),
            "economics_note": "Synthetic example values, not sourced; edit to your own numbers.",
            "goals": {"priorities": {"profit": 3, "soil_cover": 2, "weather_resilience": 2}},
            "loss_assumptions": {"dry_spring_pct": None, "heavy_rain_pct": None},
            "resolution_note": "These fields share one NASA POWER weather cell (about "
            "0.5 x 0.625 degrees) and the same historical weather series."}
