"""Per-candidate indicator vectors (P2). Definitions and sources: ``docs/indicators.md``.

Every indicator is read from the existing analysis of the candidate's legs (``PlanComparison``),
computed with one frozen ThresholdSet at one weather cell. No indicator is a measured outcome and
none is ever combined with another into a score. A value that cannot be computed is ``None`` with
a status and reason, never 0.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Any

from fieldshift.catalogs.index import CatalogIndex
from fieldshift.compare.models import PlanComparison
from fieldshift.contracts import Plan, Status

LOWER, HIGHER = "lower_better", "higher_better"

FAO_CA = {"title": "FAO, Conservation Agriculture (principles)",
          "url": "https://www.fao.org/conservation-agriculture/en/"}  # fmt: skip
NRCS = {"title": "USDA NRCS, Soil Health (principles; not re-checked 2026-11-14)",
        "url": "https://www.nrcs.usda.gov/conservation-basics/natural-resource-concerns/soils/soil-health"}  # fmt: skip
POWER_GWETROOT = {"title": "NASA POWER parameter GWETROOT (MERRA-2 root-zone soil wetness)",
                  "url": "https://power.larc.nasa.gov/api/system/manager/parameters/GWETROOT"}  # fmt: skip
FS_DRY = {"title": "Field Shift dry pre-plant window: bottom 20% of this cell's own 1981-2025 "
                   "30-day totals (calculation)", "url": None}  # fmt: skip
FS_METHOD = {"title": "Field Shift indicator definitions (backend/docs/indicators.md)", "url": None}
PLANTS = {"title": "Botanical family by genus (APG IV; USDA PLANTS Database)",
          "url": "https://plants.usda.gov"}  # fmt: skip


@dataclass(frozen=True)
class Spec:
    name: str
    unit: str
    direction: str
    origin: str
    definition: str
    rationale: str
    source: dict[str, Any]
    per_season: bool = False  # has a per-season series (historical vulnerabilities)


SPECS: dict[str, Spec] = {s.name: s for s in [
    Spec("rain_on_bare_soil_mm", "mm per season", LOWER, "calculation",
         "Median per-season rain on off-season days with no planned living cover.",
         "Rain on uncovered soil is what soil cover is meant to intercept. Rainfall depth only: "
         "not erosion, runoff or soil loss.", FAO_CA, True),
    Spec("heavy_rain_days_on_bare_soil", "days per season", LOWER, "calculation",
         "Median per-season count of heavy-rain days with no planned living cover (NC: 76.2 mm; "
         "elsewhere the cell's ETCCDI R95p value).",
         "Intense rain on uncovered soil; a count of weather events, not damage.", FAO_CA, True),
    Spec("dry_pre_plant_frequency", "share of seasons", LOWER, "calculation",
         "Share of evaluable seasons whose 30 days before planting were dry (bottom 20% of this "
         "cell's own totals for that window).",
         "How often this planting window started dry in this cell's history; it describes the "
         "window's weather, not the plan's effect on it.", FS_DRY, True),
    Spec("modeled_root_zone_wetness_at_planting", "fraction (0-1)", HIGHER, "nasa_modeled",
         "Median over seasons of mean modeled root-zone wetness (GWETROOT) in the 30 days before "
         "planting.",
         "Modeled soil water near planting. The same for any plan with the same planting date; "
         "not a water saving.", POWER_GWETROOT, True),
    Spec("living_cover_days", "days per year", HIGHER, "calculation",
         "Planned living-cover days (cover crop seed to termination, or growing winter grain). "
         "Planned; establishment uncertain.",
         "Keep the soil covered and living roots in it as long as possible.", FAO_CA),
    Spec("bare_soil_days", "days per year", LOWER, "calculation",
         "Off-season days with no planned living cover.",
         "The same principle as living cover days, seen from the other side.", FAO_CA),
    Spec("crop_family_diversity", "botanical families", HIGHER, "calculation",
         "Distinct plant families among every crop in the candidate.",
         "Species diversification through varied crop sequences.", FAO_CA),
    Spec("rule_flags", "checks per season", LOWER, "calculation",
         "Per leg, the distinct catalog rule checks that flagged in at least one past season plus "
         "the rule lines that need a manual check (the winter-wheat path's lines included); mean "
         "over legs. Unevaluable rules are listed, not counted. Each rule cites its own source.",
         "Published guidance that would have asked for a check or a change.", FS_METHOD),
    Spec("management_operations", "operations per season", LOWER, "calculation",
         "Planned field operations per season: previous harvest and next planting, plus cover "
         "seed and termination or winter-grain planting and harvest.",
         "A plain count used only for the management-simplicity priority; not a cost or labour "
         "estimate.", FS_METHOD),
    Spec("irrigation_dependence", "none", LOWER, "calculation",
         "Not computed: there is no sourced crop water-need table yet.",
         "Listed so the gap is visible; never used for a shortlist.", FS_METHOD),
]}  # fmt: skip

#: priority (P1) -> indicators (docs/indicators.md)
PRIORITY_INDICATORS: dict[str, tuple[str, ...]] = {
    "soil_cover": ("living_cover_days", "bare_soil_days", "rain_on_bare_soil_mm"),
    "water_conservation": ("modeled_root_zone_wetness_at_planting",
                           "heavy_rain_days_on_bare_soil"),  # fmt: skip
    "weather_resilience": ("dry_pre_plant_frequency", "rule_flags"),
    "crop_diversity": ("crop_family_diversity",),
    "living_cover_duration": ("living_cover_days",),
    "management_simplicity": ("management_operations",),
}
PRIORITIES = tuple(PRIORITY_INDICATORS)
USABLE = tuple(n for n in SPECS if n != "irrigation_dependence")

GENUS_FAMILY: dict[str, str] = {
    **dict.fromkeys(("Zea", "Triticum", "Secale", "Hordeum", "Avena", "Sorghum", "Oryza",
                     "Pennisetum", "Lolium", "Saccharum"), "Poaceae"),
    **dict.fromkeys(("Glycine", "Trifolium", "Vicia", "Pisum", "Arachis", "Phaseolus", "Medicago",
                     "Cicer", "Lens", "Vigna"), "Fabaceae"),
    **dict.fromkeys(("Brassica", "Raphanus", "Sinapis"), "Brassicaceae"),
    "Helianthus": "Asteraceae", "Gossypium": "Malvaceae", "Fagopyrum": "Polygonaceae",
    "Solanum": "Solanaceae", "Beta": "Amaranthaceae",
}  # fmt: skip
#: crop ids used outside the NC catalog (FAO-style ids, B2) -> genus
CROP_GENUS: dict[str, str] = {
    "maize": "Zea", "field_corn": "Zea", "wheat": "Triticum", "winter_wheat": "Triticum",
    "cereal_rye": "Secale", "rye": "Secale", "barley": "Hordeum", "oats": "Avena",
    "sorghum": "Sorghum", "rice": "Oryza", "soybean": "Glycine", "crimson_clover": "Trifolium",
    "hairy_vetch": "Vicia", "peas": "Pisum", "field_pea": "Pisum", "peanut": "Arachis",
    "groundnut": "Arachis", "alfalfa": "Medicago", "chickpea": "Cicer", "lentil": "Lens",
    "cowpea": "Vigna", "canola": "Brassica", "rapeseed": "Brassica", "radish": "Raphanus",
    "sunflower": "Helianthus", "cotton": "Gossypium", "buckwheat": "Fagopyrum",
    "potato": "Solanum", "sugarbeet": "Beta", "sugar_beet": "Beta",
}  # fmt: skip


def family_of(crop_id: str, index: CatalogIndex) -> str | None:
    crop = index.crop(crop_id)
    fam = getattr(crop, "family", None) if crop is not None else None
    if fam:  # the catalog's own family wins (catalog v3)
        return str(fam)
    genus = None
    if crop is not None and crop.scientific_name:
        genus = crop.scientific_name.split()[0]
    genus = genus or CROP_GENUS.get(crop_id)
    return GENUS_FAMILY.get(genus) if genus else None


@dataclass
class Indicator:
    name: str
    value: float | int | None
    status: str
    reason: str | None = None
    per_leg: list[Any] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)

    def public(self, *, in_priorities: bool) -> dict[str, Any]:
        s = SPECS[self.name]
        return {
            "value": self.value, "unit": s.unit, "direction": s.direction, "origin": s.origin,
            "status": self.status, "reason": self.reason, "definition": s.definition,
            "rationale": s.rationale, "source": s.source, "per_leg": self.per_leg,
            "in_priorities": in_priorities, **({"detail": self.detail} if self.detail else {}),
        }  # fmt: skip


def _usable(pc: PlanComparison) -> bool:
    return (pc.status in (Status.COMPLETE, Status.PARTIAL) and pc.winter is not None
            and pc.spring is not None and pc.calendar is not None)  # fmt: skip


def _mean(values: list[float | None], digits: int = 3) -> float | None:
    if not values or any(v is None for v in values):
        return None
    return round(statistics.fmean(v for v in values if v is not None), digits)


def _leg_values(pc: PlanComparison, has_rules: bool) -> dict[str, Any]:
    """One leg's raw values (``None`` where not computable)."""
    if not _usable(pc):
        return {**{n: None for n in USABLE}, "_unknown_rules": [],
                "_dry_counts": {"dry_seasons": None, "eligible_seasons": None}}
    assert pc.winter and pc.spring and pc.calendar and pc.plan
    med = pc.winter.per_season_median
    sp = pc.spring
    dry = (sp.dry_seasons / sp.eligible_seasons
           if sp.dry_seasons is not None and sp.eligible_seasons else None)  # fmt: skip
    wet = [s.gwetroot_window_mean for s in pc.seasons if s.gwetroot_window_mean is not None]
    flags: list[str] | None = None
    unknown_rules: list[str] = []
    if has_rules:
        found = {r for c in pc.spring_checks if c.count > 0 for r in c.rule_ids}
        found |= {r.rule_id for r in pc.other_checks
                  if r.flagged or r.status == Status.MANUAL_CHECK}  # fmt: skip
        unknown = {r.rule_id for r in pc.other_checks if r.status == Status.UNKNOWN}
        rc = (pc.double_crop or {}).get("rule_checks") or {}  # the wheat path's own rule lines
        for bucket in ("flagged", "manual_check"):
            found |= {x["rule_id"] for x in rc.get(bucket, []) if isinstance(x, dict)}
        unknown |= {x["rule_id"] for x in rc.get("unknown", []) if isinstance(x, dict)}
        flags = sorted(found)
        unknown_rules = sorted(unknown - found)
    kind = pc.plan.winter.kind
    return {
        "rain_on_bare_soil_mm": med.get("rain_mm_outside_cover"),
        "heavy_rain_days_on_bare_soil": med.get("heavy_rain_days_outside_cover"),
        "dry_pre_plant_frequency": round(dry, 4) if dry is not None else None,
        "_dry_counts": {"dry_seasons": sp.dry_seasons, "eligible_seasons": sp.eligible_seasons},
        "modeled_root_zone_wetness_at_planting": (
            round(statistics.median(wet), 4) if wet else None),
        "living_cover_days": pc.calendar.living_cover_days_planned,
        "bare_soil_days": pc.calendar.days_without_planned_cover,
        "rule_flags": flags,
        "_unknown_rules": unknown_rules,
        "management_operations": 4 if kind in ("cover", "winter_grain") else 2,
    }


def candidate_indicators(
    legs: list[PlanComparison], plans: list[Plan], index: CatalogIndex, *, has_rules: bool
) -> dict[str, Indicator]:
    """Indicators of one candidate: each leg's value, then the mean over its legs."""
    per = [_leg_values(pc, has_rules) for pc in legs]
    out: dict[str, Indicator] = {}
    for name in ("rain_on_bare_soil_mm", "heavy_rain_days_on_bare_soil",
                 "modeled_root_zone_wetness_at_planting", "living_cover_days", "bare_soil_days",
                 "management_operations"):  # fmt: skip
        vals = [p[name] for p in per]
        v = _mean(vals, 4 if "wetness" in name else 1)
        out[name] = Indicator(name, v, "complete" if v is not None else "unavailable",
                              None if v is not None else "a leg has no value for this indicator",
                              vals)  # fmt: skip
    dry_vals = [p["dry_pre_plant_frequency"] for p in per]
    v = _mean(dry_vals, 4)
    out["dry_pre_plant_frequency"] = Indicator(
        "dry_pre_plant_frequency", v, "complete" if v is not None else "unavailable",
        None if v is not None else "a leg has no dry cutoff or no evaluable seasons",
        [{"value": p["dry_pre_plant_frequency"], **p["_dry_counts"]} for p in per])  # fmt: skip
    if not has_rules:
        out["rule_flags"] = Indicator("rule_flags", None, "unknown", "no_regional_catalog")
    else:
        lists = [p["rule_flags"] for p in per]
        if any(x is None for x in lists):
            out["rule_flags"] = Indicator("rule_flags", None, "unavailable",
                                          "a leg could not be checked")  # fmt: skip
        else:
            ids = sorted({r for x in lists for r in x})  # type: ignore[union-attr]
            unresolved = sorted({r for p in per for r in p["_unknown_rules"]})
            counts = [len(x) for x in lists]  # type: ignore[arg-type]
            out["rule_flags"] = Indicator(
                "rule_flags", _mean(counts, 1), "partial" if unresolved else "complete",
                "some rules could not be evaluated (unknown)" if unresolved else None, counts,
                {"rule_ids": ids, "unknown_rule_ids": unresolved})  # fmt: skip
    crops = [c for p in plans for c in (p.previous_crop_id, p.winter.crop_id, p.next_crop_id) if c]
    fams = {c: family_of(c, index) for c in dict.fromkeys(crops)}
    unknown = [c for c, f in fams.items() if f is None]
    out["crop_family_diversity"] = Indicator(
        "crop_family_diversity", None if unknown else len(set(fams.values())),
        "unknown" if unknown else "complete",
        f"no botanical family for: {', '.join(unknown)}" if unknown else None,
        detail={"families": {c: f for c, f in fams.items()}, "family_source": PLANTS})  # fmt: skip
    out["irrigation_dependence"] = Indicator("irrigation_dependence", None, "unknown",
                                             "no sourced crop water-need data")  # fmt: skip
    return out


def indicator_set(priorities: dict[str, int]) -> dict[str, int]:
    """``{indicator: weight}`` for the shortlist: the union over priorities with weight > 0,
    each indicator taking the largest weight that names it. No priority: every usable indicator,
    weight 1."""
    weights: dict[str, int] = {}
    for p, w in priorities.items():
        if w and w > 0:
            for ind in PRIORITY_INDICATORS[p]:
                weights[ind] = max(weights.get(ind, 0), int(w))
    return weights or dict.fromkeys(USABLE, 1)
