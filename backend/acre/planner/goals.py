"""Goals, hard constraints and soft preferences for generating rotations (card P1, contract §8).

* **Priorities** come from a fixed list, each weighted 0-3 (0 = "don't care"). Weights are relative.
  They are never turned into a score: P2 uses them only to order a Pareto shortlist.
* **Constraints** are hard: a candidate that breaks one is never returned.
* **Preferences** are soft: they only order candidates.
* **Unknown stays unknown.** ``irrigation: "unknown"`` never counts as "no"; a field left out is not
  a constraint.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from acre.catalogs import crop_ids
from acre.field.equipment import Reading, check_equipment, check_readings

PRIORITY_IDS: tuple[str, ...] = (
    "soil_cover", "water_conservation", "weather_resilience", "crop_diversity",
    "living_cover_duration", "management_simplicity",
)  # fmt: skip
EQUIPMENT_LIMITS: tuple[str, ...] = (
    "no_drill_interseeding", "no_roller_crimper", "no_no_till_planter", "no_grain_drill",
    "no_sprayer",
)  # fmt: skip
# The generator enumerates every crop sequence and every leg option for each season (generator.py,
# the ``product(...)`` loops), so its cost grows about 10x per season: measured offline, about 0.7 s
# at 4 seasons for Union County and about 5 s for Pergamino. Longer rotations are fine to simulate,
# check and lay out (``MAX_ROTATION_LEGS`` in ``acre.contracts``); they are just not searched for.
MAX_GENERATED_SEASONS = 4

_MMDD = re.compile(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")
_DAYS = {1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}


def _mmdd(v: str | None) -> str | None:
    if v is None:
        return None
    if not isinstance(v, str) or not _MMDD.match(v) or int(v[3:]) > _DAYS[int(v[:2])]:
        raise ValueError("must be a calendar date as MM-DD")
    return v


def _crop_list(v: list[str] | None, name: str) -> list[str] | None:
    if v is None:
        return None
    bad = [c for c in v if not crop_ids.is_known(c)]
    if bad:
        raise ValueError(f"unknown crop id(s) {bad}")
    return [crop_ids.canonical(c) for c in v]  # type: ignore[misc]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Constraints(_Strict):
    allowed_crops: list[str] | None = None  # None = any crop the catalog supports
    excluded_crops: list[str] = Field(default_factory=list)
    must_include: list[str] = Field(default_factory=list)
    irrigation: Literal["yes", "no", "unknown"] = "unknown"
    equipment: list[str] = Field(default_factory=list)
    latest_planting: str | None = None  # MM-DD
    earliest_harvest: str | None = None  # MM-DD
    seasons: int = Field(default=2, ge=1, le=MAX_GENERATED_SEASONS)

    @field_validator("allowed_crops", "excluded_crops", "must_include")
    @classmethod
    def _crops(cls, v, info):  # noqa: ANN001
        return _crop_list(v, info.field_name)

    @field_validator("latest_planting", "earliest_harvest")
    @classmethod
    def _dates(cls, v):  # noqa: ANN001
        return _mmdd(v)

    @field_validator("equipment")
    @classmethod
    def _equipment(cls, v: list[str]) -> list[str]:
        bad = [e for e in v if e not in EQUIPMENT_LIMITS]
        if bad:
            raise ValueError(f"unknown equipment limit(s) {bad}; use {list(EQUIPMENT_LIMITS)}")
        return sorted(set(v))

    @model_validator(mode="after")
    def _consistent(self) -> Constraints:
        clash = set(self.must_include) & set(self.excluded_crops)
        if clash:
            raise ValueError(f"crop(s) {sorted(clash)} are both required and excluded")
        if self.allowed_crops is not None:
            outside = set(self.must_include) - set(self.allowed_crops)
            if outside:
                raise ValueError(f"must_include crop(s) {sorted(outside)} are not allowed")
        return self


class Preferences(_Strict):
    liked_crops: list[str] = Field(default_factory=list)
    disliked_crops: list[str] = Field(default_factory=list)

    @field_validator("liked_crops", "disliked_crops")
    @classmethod
    def _crops(cls, v, info):  # noqa: ANN001
        return _crop_list(v, info.field_name)


class Goals(_Strict):
    priorities: dict[str, Any] = Field(default_factory=lambda: {p: 1 for p in PRIORITY_IDS})
    constraints: Constraints = Field(default_factory=Constraints)
    preferences: Preferences = Field(default_factory=Preferences)

    @field_validator("priorities", mode="before")
    @classmethod
    def _priorities(cls, v: Any) -> dict[str, int]:
        if not isinstance(v, dict):
            raise ValueError("priorities must be an object of weights")
        bad = [k for k in v if k not in PRIORITY_IDS]
        if bad:
            raise ValueError(f"unknown priority id(s) {bad}; use {list(PRIORITY_IDS)}")
        for k, w in v.items():
            if isinstance(w, bool) or not isinstance(w, int) or not 0 <= w <= 3:
                raise ValueError(f"weight of {k} must be a whole number 0-3")
        # a priority left out is "don't care" (0), never a guess
        return {p: v.get(p, 0) for p in PRIORITY_IDS}


class FieldContext(_Strict):
    field_id: str | None = None
    area_ha: float | None = Field(default=None, gt=0)
    crop_history: list[str] = Field(default_factory=list, max_length=3)  # oldest first
    soil: dict | None = None  # context only; never turned into a benefit
    name: str | None = Field(default=None, max_length=120)
    geometry: dict | None = None  # display only; the backend recomputes any area it needs
    equipment: list[str] = Field(default_factory=list)  # S5 vocabulary; empty = not given
    readings: list[Reading] = Field(default_factory=list)  # grower readings; context only

    @field_validator("equipment")
    @classmethod
    def _equipment(cls, v: list[str]) -> list[str]:
        return check_equipment(v)

    @field_validator("readings")
    @classmethod
    def _readings(cls, v: list[Reading]) -> list[Reading]:
        return check_readings(v)

    @field_validator("crop_history")
    @classmethod
    def _history(cls, v: list[str]) -> list[str]:
        return _crop_list(v, "crop_history") or []
