# Indicators for plan recommendations (P2)

Owner: Agent A. Code: `fieldshift/compare/indicators.py`, `fieldshift/compare/pareto.py`, `fieldshift/compare/recommend.py`. Endpoint: `POST /v1/plans/recommend` (`docs/global/contract.md` §9).

## What an indicator is, and what it is not

An indicator is a named, documented number computed from the existing historical analysis of one candidate plan at one weather cell. Each one comes with `{value, unit, direction, origin, definition, source, rationale}`.

- An indicator is **not a measured outcome**. "More living cover days" is linked to soil health by published principles. It is not a prediction of a soil-health change, erosion, yield or water saved, and the app never prints such a figure.
- There is **no composite score**. Indicators are never added, averaged or weighted together into one number. The farmer's priorities only choose which indicators define the shortlist and in which order it is shown (see "Ordering").
- **Blank is not zero.** An indicator that cannot be computed is `value: null` with a `status` and a reason. A candidate with a null indicator in the set being compared is listed as `not_comparable`, never treated as 0.
- Values for a candidate with several seasons (legs) are the **mean over its legs** of each leg's per-season value, and the per-leg values are listed. Legs share one location and one weather series. Values are never summed across fields, locations or datasets.

## Principles the indicators lean on (sources)

| Id | Principle | Source |
|---|---|---|
| `fao_ca_cover` | "Permanent soil organic cover (at least 30 percent) with crop residues and/or cover crops." | FAO, Conservation Agriculture, https://www.fao.org/conservation-agriculture/en/ (principle 2; fetched 2026-11-14) |
| `fao_ca_diversity` | "Species diversification through varied crop sequences and associations involving at least three different crops." | Same page (principle 3; fetched 2026-11-14) |
| `fao_ca_disturbance` | "Minimum mechanical soil disturbance (i.e. no tillage) through direct seed and/or fertilizer placement." | Same page (principle 1; fetched 2026-11-14) |
| `nrcs_soil_health` | The USDA NRCS soil health principles (minimise disturbance, maximise soil cover, maximise biodiversity, maximise living roots). | USDA NRCS, Soil Health, https://www.nrcs.usda.gov/conservation-basics/natural-resource-concerns/soils/soil-health. **Not re-checked:** the site timed out on 2026-11-14. Cited as a secondary source only; FAO is the primary one. |
| `etccdi_r95p` | Heavy-rain day outside NC: daily precipitation ≥ the cell's 95th percentile of wet days (≥ 1 mm), base 1981–2010. | Zhang, X. et al. (2011) "Indices for monitoring changes in extremes based on daily temperature and precipitation data", *WIREs Climate Change* 2(6):851–870, doi:10.1002/wcc.147 |
| `nc_heavy_rain` | Heavy-rain day in NC: ≥ 3 in (76.2 mm) in 24 h. | Catalog v2 row `fc_v2_ref_very_heavy_rain` (NC Climate Science Report: Plain Language Summary, March 2020, PDF p. 4) |
| `fs_dry_spring` | Dry pre-plant window: the 30 days before planting are in the bottom 20% of this cell's own 1981–2025 totals for that window. | Field Shift method (Phase 4a, `metrics/spring.py`), a calculation, not a published agronomic threshold |
| `power_gwetroot` | Root-zone soil wetness, 0 = dry, 1 = saturated, MERRA-2 model output. | NASA POWER parameter `GWETROOT` (https://power.larc.nasa.gov/api/system/manager/parameters/GWETROOT) |
| catalog rules | Rule checks (for example `cr_tt_03`, the short rye-to-soybean gap in a dry spring). | Each rule's own `source_title`, `source_url` and `source_locator` in the location's catalog |

## Indicator definitions

| Indicator | Unit | Direction | Origin | Definition (per leg, then mean over legs) | Rationale and source |
|---|---|---|---|---|---|
| `rain_on_bare_soil_mm` | mm per season | lower_better | calculation (from `nasa_modeled` POWER rain) | Median over the leg's eligible seasons of rain falling on days with no planned living cover in the off-season window `[previous harvest, planting)`. Same number as compare `winter.per_season_median.rain_mm_outside_cover`. | Rain on uncovered soil is what soil cover is meant to intercept (`fao_ca_cover`, `nrcs_soil_health`). Rainfall depth only: not erosion, runoff or soil loss. |
| `heavy_rain_days_on_bare_soil` | days per season | lower_better | calculation | Median over eligible seasons of heavy-rain days (NC: `nc_heavy_rain`; elsewhere `etccdi_r95p`) with no planned living cover. Same as compare `winter.per_season_median.heavy_rain_days_outside_cover`. | As above: intense rain on uncovered soil (`fao_ca_cover`). A count of weather events, not damage. |
| `dry_pre_plant_frequency` | share of seasons (0–1) | lower_better | calculation | `dry_seasons / eligible_seasons` for the leg's own 30-day pre-plant window and its frozen dry cutoff (`fs_dry_spring`). The per-leg numerator and denominator are kept in `per_leg`. | How often this planting window started dry in this cell's history. It describes the weather of the window, not the plan's effect on it. |
| `modeled_root_zone_wetness_at_planting` | fraction (0–1) | higher_better | nasa_modeled | Median over seasons of the mean `GWETROOT` across the 30-day pre-plant window (compare `seasons[].gwetroot_window_mean`). | Modeled soil water near planting (`power_gwetroot`). It is the same for any plan with the same planting date: it describes the window's weather, not a water saving. |
| `living_cover_days` | days per year | higher_better | calculation | Planned living-cover days in the reference-year calendar (compare `calendar.living_cover_days_planned`): cover crop `[seed, terminate)` or growing winter grain. Planned, establishment uncertain. | Keep living roots and cover in the soil as long as possible (`nrcs_soil_health`, `fao_ca_cover`). |
| `bare_soil_days` | days per year | lower_better | calculation | Off-season days with no planned living cover (compare `calendar.days_without_planned_cover`). | Same principle as `living_cover_days`, seen from the other side. |
| `crop_family_diversity` | distinct botanical families | higher_better | calculation | Number of distinct plant families among every crop in the candidate (previous, winter and next crop of each leg). Family from the genus of the catalog's `scientific_name` (table below); a crop whose family is unknown makes the indicator `null`. | Species diversification across the sequence (`fao_ca_diversity`). |
| `rule_flags` | checks per season | lower_better | calculation (counts of catalog rule results) | Per leg: the distinct rule checks that flagged in at least one historical season, plus rule lines needing `manual_check` (the winter-wheat double-crop path's own lines included). Mean over legs. The rule ids are listed in `detail.rule_ids`; rules that could not be evaluated are listed in `detail.unknown_rule_ids`, are not counted, and make the status `partial`. Where no rules are loaded this is `null` (status `unknown`), never 0. | Each rule cites its own source (catalog). |
| `management_operations` | operations per season | lower_better | calculation | Field operations per leg: harvest of the previous crop and planting of the next crop (2), plus cover seed and termination (2) or winter-grain planting and harvest (2). Mean over legs. | A plain count of planned operations, used only for the `management_simplicity` priority. It is a proxy, not a cost or labour estimate. |
| `irrigation_dependence` | none | — | — | Not computed: there is no sourced crop water-need table yet. Always `status: unknown`, and never mapped to a priority. Listed so the gap is visible. | — |

### Crop families (genus → family)

| Genus | Family | Crops in catalogs |
|---|---|---|
| Zea, Triticum, Secale, Hordeum, Avena, Sorghum, Oryza, Pennisetum, Lolium, Saccharum | Poaceae | field_corn / maize, winter_wheat / wheat, cereal_rye, barley, oats, sorghum, rice, pearl millet, ryegrass, sugarcane |
| Glycine, Trifolium, Vicia, Pisum, Arachis, Phaseolus, Medicago, Cicer, Lens, Vigna | Fabaceae | soybean, crimson_clover, hairy vetch, peas, peanut, beans, alfalfa, chickpea, lentil, cowpea |
| Brassica, Raphanus, Sinapis | Brassicaceae | canola / rapeseed, radish, mustard |
| Helianthus | Asteraceae | sunflower |
| Gossypium | Malvaceae | cotton |
| Fagopyrum | Polygonaceae | buckwheat |
| Solanum | Solanaceae | potato |
| Beta | Amaranthaceae | sugar beet |

Standard botanical classification (APG IV; the USDA PLANTS Database, https://plants.usda.gov, lists the family on each genus page). Origin of the mapping: `verified_source` for the classification itself. The count is a `calculation`.

## Priorities → indicators (used for the Pareto set)

| Priority (P1) | Indicators |
|---|---|
| `soil_cover` | `living_cover_days`, `bare_soil_days`, `rain_on_bare_soil_mm` |
| `water_conservation` | `modeled_root_zone_wetness_at_planting`, `heavy_rain_days_on_bare_soil` |
| `weather_resilience` | `dry_pre_plant_frequency`, `rule_flags` |
| `crop_diversity` | `crop_family_diversity` |
| `living_cover_duration` | `living_cover_days` |
| `management_simplicity` | `management_operations` |

- A priority with weight 0 contributes nothing. The indicator set is the union over priorities with weight > 0. An indicator named by several priorities takes the **largest** of their weights (no double counting).
- With no non-zero priority, the set is every indicator above except `irrigation_dependence` (and except `rule_flags` where no rules are loaded). A requested indicator is never dropped: if it is unknown for a candidate, that candidate is `not_comparable`.

## Shortlist (Pareto) and ordering

1. Compute every indicator for every candidate at the same location, with the same catalog and the same frozen thresholds.
2. **Comparable** candidates have a non-null value for every indicator in the set. The others go to `not_comparable` with the missing indicator names.
3. Candidate A **dominates** B when A is at least as good on every indicator in the set and strictly better on at least one (direction-aware). Exactly equal vectors dominate neither way, so both stay. One comparable candidate is its own shortlist.
4. The **shortlist** is the non-dominated comparable candidates. Each dominated candidate lists who dominates it.
5. **Ordering** of the shortlist: for each indicator, rank the shortlisted candidates (1 = best; ties share the lower rank). Sort by the sum over indicators of `weight × rank position`, then by `candidate_id`. Only rank positions are combined, never raw values across units, and that sum is used for sorting only: it is not returned. The response returns each candidate's rank position per indicator and names the method.
6. Changing the weights can change the indicator set (and so the shortlist) and the order. It never changes an indicator value.
7. The response always says: "Not universally optimal: depends on these priorities and this weather history."

## Explanations

- `wins`: indicators in the set where the candidate holds rank 1 in the shortlist. `loses`: indicators where it holds the worst rank and that rank is above 1.
- `why`: one sentence per win with the value, the other shortlisted values, the unit and the source.
- `trade_offs`: against each other shortlisted candidate, the indicators where it is worse. This includes indicators outside the farmer's set, marked `in_priorities: false`, so a weakness is never hidden.
- `uncertainties`: modeled inputs (`nasa_modeled`), assumed demo dates, `ai_suggested` or `dataset_estimate` inputs, no regional catalog, fewer than 40 usable years, and the shared weather cell.
- `historical_vulnerabilities`: the candidate's weakest indicator that has a per-season series (rain on bare soil, heavy-rain days, pre-plant rain, root-zone wetness), and its worst 3 seasons on it, each with a ready replay request (`POST /v1/seasons/{year}/replay` with the leg's plan and the same location: NC place id, cell id, or a 2-decimal point).
- `uncertainties` also name weak provenance of the inputs: a regional catalog that is `ai_suggested`, `source_checked` or `dataset_estimate`, and the same origins on a generated candidate's dates or rules.
- Soil context (texture, SOC, drainage) from the request is echoed as `context.soil` and is never turned into a number.
