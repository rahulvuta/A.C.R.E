"""Request-local effective conditions. Grower measurements take precedence over estimates."""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from typing import Any

import pandas as pd

from acre.field.equipment import READINGS, Reading
from acre.weather.series import DailySeries

BASELINE_NOTE = "Regional estimate used where no field measurement was entered."


def reading_key(r: Reading) -> str:
    return f"custom:{r.name.strip().lower()}:{r.unit.strip().lower()}" if r.kind == "custom" else r.kind


def latest_readings(readings: list[Reading], at: date) -> dict[str, Reading]:
    latest: dict[str, Reading] = {}
    for r in readings:
        if r.kind == "note" or r.date > at:
            continue
        key = reading_key(r)
        if key not in latest or r.date >= latest[key].date:
            latest[key] = r
    return latest


def weather_overrides(ctx: Any, readings: list[Reading]) -> tuple[Any, list[dict[str, Any]]]:
    """Change a private copy only on matching dates; the shared snapshot stays immutable.

    VWC and uncalibrated sensor percentages cannot be substituted for NASA saturation.
    Soil temperature cannot be substituted for air temperature.
    """
    if not readings:
        return ctx, []
    frame = ctx.series.frame.copy()
    used: dict[tuple[str, str], dict[str, Any]] = {}
    for r in readings:
        variable, value = None, r.value
        if r.kind == "rainfall_mm":
            variable = "precip_mm"
        elif (r.kind == "soil_moisture_pct" and r.moisture_basis == "saturation"
              and (r.depth_cm is None or r.depth_cm <= 5)):
            variable, value = "gwettop", r.value / 100
        if variable is None or variable not in frame or r.date > date.today():
            continue
        when = pd.Timestamp(r.date)
        if when not in frame.index:
            continue
        frame.loc[when, variable] = value
        used[(r.date.isoformat(), variable)] = {
            "date": r.date.isoformat(), "variable": variable, "value": value,
            "origin": "grower", "depth_cm": r.depth_cm,
        }
    if not used:
        return ctx, []
    return replace(ctx, series=DailySeries(frame.reset_index())), list(used.values())


def effective_conditions(readings: list[Reading], *, ctx: Any = None,
                         soil: Any = None, at: date | None = None) -> dict[str, Any]:
    at = at or date.today()
    baselines: dict[str, dict[str, Any]] = {}
    if ctx is not None:
        frame = ctx.series.frame
        same_day = pd.Timestamp(at) in frame.index
        rows = frame.loc[[pd.Timestamp(at)]] if same_day else frame.loc[
            (frame.index.month == at.month) & (frame.index.day == at.day)]
        for kind, column, scale, label in (
            ("rainfall_mm", "precip_mm", 1, "Daily rainfall"),
            ("soil_moisture_pct", "gwettop", 100, "Surface wetness (% saturation)"),
        ):
            vals = rows[column].dropna() if column in rows else []
            value = round(float(vals.median()) * scale, 3) if len(vals) else None
            baselines[kind] = {
                "value": value, "origin": "nasa_modeled", "label": label,
                "source": {"title": "NASA POWER", "url": "https://power.larc.nasa.gov/"},
                "note": ("Estimate for this date." if same_day else
                         "Historical median for this calendar day; not a current measurement."),
                "moisture_basis": "saturation" if kind == "soil_moisture_pct" else None,
            }
    if soil is not None:
        ph = next((p for p in soil.properties if p.name == "ph_water"), None)
        if ph:
            surface = next((v for v in ph.values if v.value is not None), None)
            if surface:
                baselines["soil_ph"] = {"value": surface.value, "origin": "dataset_estimate",
                    "source": soil.source, "note": f"SoilGrids estimate at {surface.depth}."}
    latest = latest_readings(readings, at)
    keys = list(dict.fromkeys(["soil_ph", "soil_moisture_pct", "soil_moisture_vwc",
                              "rainfall_mm", "soil_temp_c", "organic_matter_pct", "salinity_ds_m",
                              *latest]))
    rows = []
    for key in keys:
        r, baseline = latest.get(key), baselines.get(key)
        kind = r.kind if r else key
        label, unit, _, _ = READINGS[kind]
        rows.append({
            "key": key, "kind": kind, "label": r.name if kind == "custom" else label,
            "unit": r.unit if kind == "custom" else unit,
            "value": r.value if r else (baseline or {}).get("value"),
            "origin": "grower" if r else (baseline or {}).get("origin"),
            "date": r.date.isoformat() if r else None,
            "depth_cm": r.depth_cm if r else None,
            "moisture_basis": r.moisture_basis if r else (baseline or {}).get("moisture_basis"),
            "baseline": baseline,
            "note": ("Your measurement is used for this field." if r else
                     (baseline or {}).get("note", "No local baseline available; enter a measurement.")),
        })
    return {"as_of": at.isoformat(), "values": rows, "note": BASELINE_NOTE}
