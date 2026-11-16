"""Field context: equipment and farmer readings (card S5, contract §14).

* ``equipment[]`` comes from a fixed vocabulary (plus ``other:<text>``). It drives the generator's
  feasibility check and the economics pass costs. An empty list means "not given", never "none".
* ``readings[]`` are dated grower measurements. Field conditions prefer these to estimates;
  compatible dated measurements also override the request's weather replay.

Both travel with each request and are never stored on the server.
"""

from __future__ import annotations

import re
from datetime import date as Date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EQUIPMENT: dict[str, str] = {
    "planter": "Row-crop planter",
    "grain_drill": "Grain drill",
    "no_till_drill": "No-till drill",
    "broadcast_seeder": "Broadcast seeder (spinner)",
    "sprayer": "Sprayer",
    "roller_crimper": "Roller-crimper",
    "disk": "Disk harrow",
    "chisel_plow": "Chisel plow",
    "field_cultivator": "Field cultivator",
    "combine": "Combine",
    "forage_harvester": "Forage harvester",
    "irrigation_pivot": "Irrigation: center pivot",
    "irrigation_drip": "Irrigation: drip",
    "irrigation_none": "No irrigation",
}
OTHER_PREFIX = "other:"
_OTHER = re.compile(r"^other:[\w .,/()+-]{1,40}$")

#: kind -> (label, unit, low, high); ``note`` carries text only.
READINGS: dict[str, tuple[str, str | None, float | None, float | None]] = {
    "soil_moisture_pct": ("Soil moisture (% of saturation or sensor %)", "%", 0.0, 100.0),
    "soil_moisture_vwc": ("Soil moisture (volumetric water content, m³/m³)", "m3/m3", 0.0, 1.0),
    "rainfall_mm": ("Rainfall (mm, own gauge)", "mm", 0.0, 1000.0),
    "soil_temp_c": ("Soil temperature (°C)", "degC", -30.0, 60.0),
    "soil_ph": ("Soil pH / acidity", "pH", 0.0, 14.0),
    "organic_matter_pct": ("Soil organic matter", "%", 0.0, 100.0),
    "salinity_ds_m": ("Soil salinity (ECe)", "dS/m", 0.0, 100.0),
    "custom": ("Other field condition", None, None, None),
    "note": ("Note", None, None, None),
}
MAX_READINGS = 500

DRILLS = ("grain_drill", "no_till_drill")
SEEDERS = ("planter", "grain_drill", "no_till_drill")
TERMINATION = {"sprayer": "herbicide", "roller_crimper": "roller_crimp", "disk": "tillage",
               "chisel_plow": "tillage", "field_cultivator": "tillage"}  # fmt: skip


def valid_equipment(v: str) -> bool:
    return v in EQUIPMENT or bool(_OTHER.match(v))


class Reading(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: Date
    kind: Literal["soil_moisture_pct", "soil_moisture_vwc", "rainfall_mm", "soil_temp_c",
                  "soil_ph", "organic_matter_pct", "salinity_ds_m", "custom", "note"]
    value: float | None = Field(default=None, allow_inf_nan=False)
    depth_cm: float | None = Field(default=None, ge=0, le=300)
    note: str | None = Field(default=None, max_length=500)
    name: str | None = Field(default=None, max_length=80)
    unit: str | None = Field(default=None, max_length=30)
    moisture_basis: Literal["saturation", "volumetric", "sensor_percent"] | None = None

    @model_validator(mode="after")
    def _value(self) -> Reading:
        _, _, lo, hi = READINGS[self.kind]
        if self.kind == "note":
            if self.value is not None:
                raise ValueError("a note reading has no value")
            if not (self.note or "").strip():
                raise ValueError("a note reading needs note text")
            return self
        if self.value is None:  # blank is not zero: a measurement must say its value
            raise ValueError(f"{self.kind} needs a value")
        if self.kind == "custom":
            if not (self.name or "").strip() or not (self.unit or "").strip():
                raise ValueError("a custom condition needs a name and unit")
        elif not lo <= self.value <= hi:  # type: ignore[operator]
            raise ValueError(f"{self.kind} must be within {lo:g}..{hi:g}")
        return self

    def as_context(self) -> dict[str, Any]:
        label, unit, _, _ = READINGS[self.kind]
        out = {"date": self.date.isoformat(), "kind": self.kind, "value": self.value,
               "unit": unit, "origin": "grower"}  # fmt: skip
        if self.depth_cm is not None:
            out["depth_cm"] = self.depth_cm
        if self.note:
            out["note"] = self.note
        if self.kind == "custom":
            out.update(name=self.name, unit=self.unit)
        if self.moisture_basis:
            out["moisture_basis"] = self.moisture_basis
        return out


def check_equipment(v: list[str]) -> list[str]:
    bad = [e for e in v if not isinstance(e, str) or not valid_equipment(e)]
    if bad:
        raise ValueError(f"unknown equipment {bad}; use {list(EQUIPMENT)} or other:<text>")
    return sorted(set(v))


def check_readings(v: list[Reading]) -> list[Reading]:
    if len(v) > MAX_READINGS:
        raise ValueError(f"at most {MAX_READINGS} readings")
    return sorted(v, key=lambda r: (r.date, r.kind, r.depth_cm or 0.0))


class FieldExtras(BaseModel):
    """The S5 part of a field object, for callers that validate it on its own (A's simulate)."""

    model_config = ConfigDict(extra="ignore")
    equipment: list[str] = Field(default_factory=list)
    readings: list[Reading] = Field(default_factory=list)

    @field_validator("equipment")
    @classmethod
    def _eq(cls, v: list[str]) -> list[str]:
        return check_equipment(v)

    @field_validator("readings")
    @classmethod
    def _rd(cls, v: list[Reading]) -> list[Reading]:
        return check_readings(v)


def readings_context(readings: list[Reading] | list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Readings as returned beside modeled values (each ``origin: grower``), sorted by date."""
    rs = [r if isinstance(r, Reading) else Reading.model_validate(r) for r in readings]
    return [r.as_context() for r in check_readings(rs)]


def vocab_equipment() -> list[dict[str, Any]]:
    out = [{"id": k, "label": v, "uses": _uses(k)} for k, v in EQUIPMENT.items()]
    out.append({"id": "other:<text>", "label": "Other (describe it)", "uses": []})
    return out


def _uses(k: str) -> list[str]:
    u = []
    if k in SEEDERS:
        u.append("planting")
    if k in DRILLS:
        u.append("cover_seeding")
    if k == "broadcast_seeder":
        u.append("cover_seeding_broadcast")
    if k in TERMINATION:
        u.append(f"termination:{TERMINATION[k]}")
    if k in ("combine", "forage_harvester"):
        u.append("harvest")
    return u


def vocab_readings() -> list[dict[str, Any]]:
    return [{"kind": k, "label": lab, "unit": unit, "min": lo, "max": hi}
            for k, (lab, unit, lo, hi) in READINGS.items()]  # fmt: skip


# --------------------------------------------------------------------------- feasibility

_BROADCAST_METHODS = {"broadcast", "broadcast_seed", "broadcast_seeding", "overseed",
                      "overseeding", "aerial_overseed", "aerial_overseeding"}


def broadcast_rule(rules: list[Any]) -> Any | None:
    """A sourced catalog rule that allows broadcasting (or overseeding) this cover, if any."""
    for r in rules:
        method = str(getattr(r, "management_action", None) or "").strip().lower()
        if (method in _BROADCAST_METHODS and getattr(r, "origin", None) in (
                "verified_source", "source_checked") and getattr(r, "source_url", None)
                and getattr(r, "review", None) != "manual_check"
                and getattr(r, "suitability", None) not in {"unsuitable", "avoid", "caution"}):
            return r
    return None


def season_feasibility(equipment: list[str], next_crop: str, cover: str | None,
                       cover_rules: list[Any], *, grain_crop: str | None = None
                       ) -> dict[str, Any]:  # fmt: skip
    """What this field's equipment can do for one season: planting, cover seeding, termination.

    ``status`` is ``complete`` when every step has equipment, ``manual_check`` when a step needs a
    person (no equipment for it), ``unknown`` when no equipment list was given."""
    if not equipment:
        return {"status": "unknown", "reason_text": "No equipment list was given, so feasibility "
                "was not checked."}  # fmt: skip
    have = set(equipment)
    steps: list[dict[str, Any]] = []
    plant_with = [e for e in SEEDERS if e in have]
    steps.append({"step": "plant", "crop_id": next_crop,
                  "status": "complete" if plant_with else "manual_check",
                  "equipment": plant_with[:1],
                  "reason_text": None if plant_with else "No planter or drill is listed."})  # fmt: skip
    if grain_crop:
        drills = [e for e in DRILLS if e in have]
        steps.append({"step": "plant", "crop_id": grain_crop, "kind": "winter_grain",
                      "status": "complete" if drills else "manual_check",
                      "equipment": drills[:1],
                      "reason_text": None if drills else "No grain drill is listed for winter grain."})  # fmt: skip
    if cover:
        drill = [e for e in DRILLS if e in have]
        if drill:
            steps.append({"step": "cover_seeding", "crop_id": cover, "method": "drill",
                          "equipment": drill[:1], "status": "complete", "reason_text": None})  # fmt: skip
        else:
            rule = broadcast_rule(cover_rules) if "broadcast_seeder" in have else None
            if rule is not None:
                steps.append({"step": "cover_seeding", "crop_id": cover, "method": "broadcast",
                              "equipment": ["broadcast_seeder"], "status": "complete",
                              "rule_id": rule.rule_id, "origin": rule.origin,
                              "reason_text": "Broadcast seeding, as a sourced rule allows."})  # fmt: skip
            else:
                why = ("A broadcast seeder is listed, but no sourced rule allows broadcasting this "
                       "cover here." if "broadcast_seeder" in have else "No drill is listed.")  # fmt: skip
                steps.append({"step": "cover_seeding", "crop_id": cover, "method": None,
                              "equipment": [], "status": "manual_check", "reason_text": why})  # fmt: skip
        methods = sorted({TERMINATION[e] for e in have if e in TERMINATION})
        steps.append({"step": "termination", "crop_id": cover, "methods": methods,
                      "status": "complete" if methods else "manual_check",
                      "reason_text": None if methods else "No sprayer, roller-crimper or tillage "
                      "tool is listed to end the cover."})  # fmt: skip
    status = "manual_check" if any(s["status"] == "manual_check" for s in steps) else "complete"
    return {"status": status, "steps": steps}
