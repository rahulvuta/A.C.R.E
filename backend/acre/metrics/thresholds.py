"""Frozen thresholds. Each one is computed once and shared by every plan and era.

Heavy-rain day (Phase 3)
------------------------
Published fixed threshold (catalog v2 row ``fc_v2_ref_very_heavy_rain``, NC Climate Science
Report: Plain Language Summary, March 2020, PDF p. 4): **very heavy rain = 3 in (76.2 mm) in 24 h**.

    heavy-rain day  <=>  daily precip_mm >= 76.2   (inclusive)

* The value, URL and locator are read from ``data/catalogs/v2/weather_references.csv`` and frozen
  into the ``Threshold`` (``source``), so the number is never hard-coded apart from its source.
* **Time convention.** NASA POWER daily values are Local Solar Time days (``time_standard=LST``,
  one solar day at the point's longitude), not a rolling 24-hour window and not a civil-time
  day. A storm that straddles two solar days can fall under 76.2 mm on each, so the count is a
  conservative reading of "3 in in 24 h". Gridded (MERRA-2 based) daily values also smooth
  point extremes. Expect few or zero qualifying days in a winter; a zero is a real result.
* Scope: a **rainfall-depth weather metric only**. It says nothing about erosion, runoff or soil
  loss, which need separate evidence.
* The rule is fixed (not relative), so it cannot change with the record, a plan or an era.

The earlier relative rule (95th percentile of wet days) was ASSUMED while the published value was
missing. It is not part of the ThresholdSet any more; ``percentile_of_wet_days`` stays available
as an explicit option (``HeavyRainRule``) for experiments and tests only.
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from acre.contracts import Status, Threshold, ThresholdSet, ThresholdSource
from acre.weather.series import DailySeries

HEAVY_RAIN_NAME = "heavy_rain_mm"
SPRING_DRY_PREFIX = "spring_dry_mm@"
REFERENCES_PATH = (
    Path(__file__).resolve().parents[2] / "data" / "catalogs" / "v2" / "weather_references.csv"
)
HEAVY_RAIN_REFERENCE_ID = "fc_v2_ref_very_heavy_rain"
MM_PER_INCH = 25.4

TIME_CONVENTION_NOTE = (
    "Applied to NASA POWER daily values, which are Local Solar Time days (time_standard=LST), "
    "not a rolling 24-hour window; a storm split across two solar days can fall below the "
    "value on each day. Rainfall-depth weather metric only: not erosion, runoff or soil loss. "
    "Zero-count winters are valid results."
)


@dataclass(frozen=True)
class HeavyRainRule:
    method: str  # "published_reference" | "percentile_of_wet_days" | "fixed_mm"
    reference_rule_id: str = HEAVY_RAIN_REFERENCE_ID
    percentile: float = 95.0  # percentile_of_wet_days only
    wet_day_min_mm: float = 1.0
    months: tuple[int, ...] = (9, 10, 11, 12, 1, 2, 3, 4, 5)
    fixed_mm: float | None = None
    note: str = TIME_CONVENTION_NOTE


HEAVY_RAIN_RULE = HeavyRainRule(method="published_reference")

#: Outside North Carolina (A2): the cell's own 95th percentile of wet days (>= 1 mm) over the
#: 1981-2010 base period, all months. That is the ETCCDI R95p threshold definition (Expert Team on
#: Climate Change Detection and Indices; Zhang et al. 2011, WIREs Climate Change 2:851-870).
ETCCDI_BASE = (1981, 2010)
ETCCDI_R95P_NOTE = (
    "This cell's own 95th percentile of wet-day (>= 1 mm) daily precipitation over the 1981-2010 "
    "base period (the ETCCDI R95p threshold definition), computed once from NASA POWER daily "
    "values and frozen. It is a local heavy-rain marker, not a published agronomic threshold. "
    "Solar-day (LST) daily values; rainfall depth only, not erosion or soil loss. Zero-count "
    "seasons are valid results."
)
ETCCDI_R95P_RULE = HeavyRainRule(method="etccdi_r95p", months=tuple(range(1, 13)),
                                 note=ETCCDI_R95P_NOTE)  # fmt: skip


class ReferenceError(RuntimeError):
    """The weather reference row is missing or unusable."""


def load_reference_row(rule_id: str, path: Path = REFERENCES_PATH) -> dict[str, str]:
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["rule_id"] == rule_id:
                return row
    raise ReferenceError(f"{rule_id} not found in {path.name}")


def _published_threshold(series: DailySeries, rule: HeavyRainRule, span: str) -> Threshold:
    row = load_reference_row(rule.reference_rule_id)
    if row["operator"] != "gte" or row["unit"] != "inches":
        raise ReferenceError(f"{rule.reference_rule_id}: expected 'gte' in inches")
    depth_in = float(row["value_min"])
    value = round(depth_in * MM_PER_INCH, 3)
    valid_days = int(series.frame["precip_mm"].notna().sum())
    return Threshold(
        name=HEAVY_RAIN_NAME, method="published_fixed", value=value, unit="mm/day",
        parameters={
            "assumed": False, "inclusive": True, "comparison": "daily precip_mm >= value",
            "depth_in": depth_in, "reference_duration_h": float(row["exposure_duration"]),
            "daily_value_basis": "NASA POWER PRECTOTCORR, time_standard=LST (solar day)",
            "scope": "rainfall depth only; not erosion or soil loss",
        },
        reference_span=span, n_reference=valid_days, note=rule.note,
        source=ThresholdSource(
            rule_id=row["rule_id"], title=row["source_title"], url=row["source_url"],
            locator=row["source_locator"], verified_date=row["verified_date"] or None,
        ),
    )


def _etccdi_r95p_threshold(series: DailySeries, rule: HeavyRainRule) -> Threshold:
    start, end = ETCCDI_BASE
    frame = series.frame
    in_base = (frame.index.year >= start) & (frame.index.year <= end)
    precip = frame.loc[in_base, "precip_mm"].dropna()
    wet = precip[precip >= rule.wet_day_min_mm]
    base_days = int(in_base.sum())
    expected = sum(366 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 365
                   for y in range(start, end + 1))  # fmt: skip
    valid = int(len(precip))
    params: dict[str, Any] = {
        "assumed": False, "inclusive": True, "comparison": "daily precip_mm >= value",
        "percentile": rule.percentile, "wet_day_min_mm": rule.wet_day_min_mm,
        "base_period": [start, end], "base_valid_days": valid, "base_expected_days": expected,
        "quantile_method": "numpy linear interpolation over wet days",
        "daily_value_basis": "NASA POWER PRECTOTCORR, time_standard=LST (solar day)",
        "scope": "rainfall depth only; not erosion or soil loss",
    }  # fmt: skip
    span = f"{start}-01-01..{end}-12-31"
    # The base period must be mostly present: at least 25 of its 30 years of valid days.
    if base_days == 0 or valid < expected * 25 / 30 or wet.empty:
        return Threshold(
            name=HEAVY_RAIN_NAME, method=rule.method, value=None, unit="mm/day",
            parameters=params, reference_span=span, n_reference=int(len(wet)),
            status=Status.INSUFFICIENT_DATA,
            note="Too little of the 1981-2010 base period is in this cell's record to fix a "
            "local heavy-rain value.",
        )  # fmt: skip
    value = round(float(np.percentile(wet.to_numpy(), rule.percentile)), 3)
    return Threshold(
        name=HEAVY_RAIN_NAME, method=rule.method, value=value, unit="mm/day", parameters=params,
        reference_span=span, n_reference=int(len(wet)), note=rule.note,
    )


def heavy_rain_threshold(series: DailySeries, rule: HeavyRainRule = HEAVY_RAIN_RULE) -> Threshold:
    span = f"{series.first_date.isoformat()}..{series.last_date.isoformat()}"
    if rule.method == "published_reference":
        return _published_threshold(series, rule, span)
    if rule.method == "etccdi_r95p":
        return _etccdi_r95p_threshold(series, rule)
    params: dict[str, Any] = {"assumed": True, "inclusive": True}
    if rule.method == "fixed_mm":
        assert rule.fixed_mm is not None
        return Threshold(
            name=HEAVY_RAIN_NAME, method="fixed_mm", value=float(rule.fixed_mm), unit="mm/day",
            parameters=params, reference_span=span, n_reference=0, note=rule.note,
        )
    frame = series.frame
    months = frame.index.month.isin(rule.months)
    precip = frame.loc[months, "precip_mm"].dropna()
    wet = precip[precip >= rule.wet_day_min_mm]
    params.update(
        percentile=rule.percentile, wet_day_min_mm=rule.wet_day_min_mm, months=list(rule.months)
    )
    if wet.empty:
        return Threshold(
            name=HEAVY_RAIN_NAME, method=rule.method, value=None, unit="mm/day", parameters=params,
            reference_span=span, n_reference=0, status=Status.UNAVAILABLE,
            note="no wet days in the reference record",
        )
    value = round(float(np.percentile(wet.to_numpy(), rule.percentile)), 3)
    return Threshold(
        name=HEAVY_RAIN_NAME, method=rule.method, value=value, unit="mm/day", parameters=params,
        reference_span=span, n_reference=int(len(wet)),
        note="ASSUMED relative rule (95th percentile of wet days); experiments only.",
    )


def is_heavy(precip_mm: float | None, threshold: Threshold) -> bool | None:
    """True/False for a valid value; ``None`` when the value or threshold is missing."""
    if precip_mm is None or threshold.value is None or (
        isinstance(precip_mm, float) and math.isnan(precip_mm)
    ):
        return None
    return precip_mm >= threshold.value


def build_threshold_set(
    series: DailySeries,
    snapshot_hash: str,
    plant_mds: tuple[str, ...] | list[str] = (),
    heavy_rule: HeavyRainRule = HEAVY_RAIN_RULE,
    location: str | None = None,
) -> ThresholdSet:
    """Compute every threshold once. Spring dry cutoffs are added per planting MM-DD (Phase 4a).

    ``location`` (the POWER cell id) and each threshold's ``origin`` are labels; they never change
    a value or the ``threshold_set_id``.
    """
    thresholds: dict[str, Threshold] = {HEAVY_RAIN_NAME: heavy_rain_threshold(series, heavy_rule)}
    if plant_mds:
        from acre.metrics.spring import spring_dry_threshold

        for md in sorted(set(plant_mds)):
            t = spring_dry_threshold(series, md)
            thresholds[t.name] = t
    labelled = {
        name: t.model_copy(update={
            "location": location,
            "origin": "verified_source" if t.source is not None else "calculation",
        })  # fmt: skip
        for name, t in thresholds.items()
    }
    return ThresholdSet(snapshot_hash=snapshot_hash, thresholds=labelled)
