"""Goal priorities with plain labels (contract §16). ``profit`` is new with the simulator; the
P2 recommendation (no money) accepts it and leaves it out."""

from __future__ import annotations

from typing import Any

from acre.compare.indicators import PRIORITIES as P2_PRIORITIES

PRIORITY_TEXT: dict[str, tuple[str, str]] = {
    "soil_cover": ("Keep the soil covered",
                   "More days with living cover and less rain falling on bare soil."),
    "water_conservation": ("Protect water and soil",
                           "Fewer heavy-rain days landing on bare soil."),
    "weather_resilience": ("Lower weather risk",
                           "Fewer dry planting windows and heavy-rain years in past weather."),
    "crop_diversity": ("Grow more kinds of crops",
                       "More plant families in the rotation."),
    "living_cover_duration": ("Living roots longer",
                              "More planned days with a growing cover or grain crop."),
    "management_simplicity": ("Keep it simple",
                              "Fewer field operations a year."),
    "profit": ("Make more money",
               "Higher median margin over the period, from your prices, yields and costs (or "
               "sourced regional references)."),
}  # fmt: skip
PRIORITIES: tuple[str, ...] = (*P2_PRIORITIES, "profit")
assert set(PRIORITIES) == set(PRIORITY_TEXT)


def priorities_vocab() -> list[dict[str, Any]]:
    return [{"priority_id": p, "label": PRIORITY_TEXT[p][0], "explanation": PRIORITY_TEXT[p][1],
             "weights": {"min": 0, "max": 3},
             "used_by": ["simulate"] + ([] if p == "profit" else ["recommend"])}
            for p in PRIORITIES]  # fmt: skip
