# Global API contract

**Status (A4, 2026-11-14):** §1, §2, §5 and §9 are shipped and match the code. The frozen source of truth is `backend/docs/api/openapi.json` plus `backend/docs/api/examples/` (regenerate with `python -m acre.api.contract`; `--check` fails when stale). Real example responses for the global endpoints: `weather_prepare_union` (committed NC cell), `weather_prepare_pergamino` (cached cell), `weather_prepare_pending`, `weather_get_offline` (`offline_no_snapshot`), `compare_pergamino`, `compare_outside_nc_offline` (was `compare_unsupported_location`), `years_post_pergamino`, `sensitivity_pergamino`, `farm_analyze_nc_pergamino`, `farm_analyze_offline`, `farm_invalid_bowtie`, `recommend_union`, `recommend_pergamino`; each has its request in `examples/requests/`. §3, §4 (B1), §6–§8 (B2, P1) and §10 (P3) are B's and are folded in as B announces them in `log-B.md`.

# (G0 draft text follows, updated per section)

Draft shapes for the new endpoints, so the frontend can build against fixtures while the backend is being written. After G0, **A owns this file**. B posts shape changes in `log-B.md`, and A folds them in. After A4, the frozen source of truth is `backend/docs/api/openapi.json` plus its examples. Where they disagree, OpenAPI wins and A fixes this file.

Rules that apply to every response:
- Every response carries `meta = {plan_version, catalog_version, snapshot_hash, request_id}`.
- Errors are HTTP 400 `invalid_input` with typed `issues[{field, code, message}]`.
- `status` uses only the 9 status words.
- Jobs report `job_status: pending|ready|failed`.
- Every value that comes from data carries `origin` (one of `nasa_measured | nasa_modeled | calculation | verified_source | source_checked | ai_suggested | grower | assumed | dataset_estimate`).
- A missing value is `null`, never 0.
- Every `reason` code has a `reason_text`.
- Coordinates in responses are rounded to 2 decimals.

## 1. Location object (used everywhere)

```json
{"latitude": -33.89, "longitude": -60.57}          // or
{"cell_id": "cell_-34.000_-60.625"}                  // a POWER grid cell
```
Existing endpoints that take `location` keep their old behaviour when it is omitted (the NC demo).

## 2. Weather on demand (A1, shipped)

`cell_id` format (unchanged from the existing NC API): `cell_<lat centre %+.3f>_<lon centre %+.3f>`, the MERRA-2 cell (0.5° lat × 0.625° lon) containing the point, e.g. `cell_-34.000_-60.625` (Pergamino), `cell_+35.000_-80.625` (Union County). Cell centres are grid values and are returned exactly (not rounded); the caller's point is never echoed.

`POST /v1/weather/prepare` with body `{"location": {"latitude", "longitude"} | {"cell_id"}, "refresh": false, "wait_s": 0}`:
- `wait_s` (0–120, default 0): block up to that long for a fetch to finish. With 0 a fetch returns `pending` at once.
- `refresh: true` is the only way to re-fetch a cached cell. It writes a new snapshot (new hash) and never rewrites the old one. It is ignored for the committed NC cells (a note says so) and offline (a note says so).

```json
{"meta": {"plan_version": null, "catalog_version": "…", "snapshot_hash": "…", "request_id": "…"},
 "cell_id": "cell_-34.000_-60.625", "job_status": "ready",
 "status": "complete", "reason": null, "reason_text": null,
 "source": "fetched", "snapshot_hash": "…", "retrieved_at": "2026-11-14T16:41:05Z",
 "cell": {"center": {"latitude": -34.0, "longitude": -60.625}, "size_deg": [0.5, 0.625],
          "note": "One NASA POWER weather series covers this whole cell."},
 "coverage": {"first_date": "1981-01-01", "last_date": "2026-11-11", "complete_years": 45,
              "complete_pre_plant_windows": null, "complete_off_seasons": null,
              "missing_days": {"PRECTOTCORR": 0, "T2M_MAX": 0, "T2M_MIN": 0, "T2M": 0, "GWETTOP": 0, "GWETROOT": 0},
              "status": "complete", "basis": "complete year = a calendar year with every parameter on every day; …"},
 "poll": null, "notes": []}
```
- `source`: `committed` (the 8 NC snapshots, always win), `cache` (fetched earlier), `fetched` (by this request), or `null` when nothing is stored.
- `meta.snapshot_hash` equals `snapshot_hash` (null when nothing is stored).
- `coverage.status`: `complete` (≥ 40 complete calendar years), `partial`, or `insufficient_data` (< 15). `complete_pre_plant_windows` and `complete_off_seasons` depend on a plan's dates, so they are `null` here; the analysis reports them as `coverage.available_years` (A2).
- `last_date` is the last day POWER serves with every parameter (recent days are fill values and are trimmed).
- `job_status: "pending"` has `status: "unknown"`, `coverage: null`, `snapshot_hash: null` and `poll: "/v1/weather/{cell_id}"`.
- `job_status: "failed"` has `status: "unavailable"` and a `reason`: `offline_no_snapshot`, `power_unreachable`, `power_error`, `power_bad_response`, `power_no_data`, `cache_write_failed`, or `not_prepared` (GET only: nobody asked for this cell yet). Every reason has a `reason_text`.
- Bad input is HTTP 400 `invalid_input` with issue codes `incomplete_point`, `location_conflict` (a point and a cell id), `invalid_cell`, or the schema's range errors.

`GET /v1/weather/{cell_id}` returns the same body and never starts a fetch.

## 3. Geo (B1)

`GET /v1/geo/search?q=Pergamino&limit=5`:
```json
{"meta": {}, "query_kind": "text|coordinates", "results": [
  {"label": "Pergamino, Buenos Aires, Argentina", "latitude": -33.89, "longitude": -60.57,
   "bbox": [-60.65, -33.95, -60.50, -33.83], "kind": "city", "source": "nominatim"}]}
```

`GET /v1/geo/reverse?lat=-33.89&lon=-60.57`:
```json
{"meta": {}, "status": "complete",
 "place": {"display": "Pergamino, Buenos Aires, Argentina", "country": "AR", "country_name": "Argentina",
           "admin1": "AR-B", "admin1_name": "Buenos Aires", "admin2_name": "Pergamino"},
 "hemisphere": "south", "on_land": true,
 "climate": {"koppen": "Cfa", "label": "Humid subtropical", "resolution_km": 5,
             "source": "Beck et al. 2023, Koppen-Geiger 1991-2020", "origin": "dataset_estimate"},
 "cell_id": "cell_-34.000_-60.625",
 "region_keys": ["AR-B", "AR", "koppen:Cfa"],
 "nc_region": null}
```
`nc_region` is `"Piedmont"`, `"Coastal Plain"` or `"Mountains"` inside NC.

## 4. Capabilities (B1; A3 embeds it per field)

`GET /v1/locations/capabilities?lat=&lon=`:
```json
{"meta": {}, "region_key": "AR-B",
 "features": {
  "weather":      {"status": "complete", "job_status": "ready", "cell_id": "…", "source": "cache", "origin": "nasa_modeled"},
  "catalog":      {"status": "partial", "origin": "ai_suggested", "region_key": "AR-B",
                   "reason_text": "Suggestions found by AI research; check them with a local adviser."},
  "soil":         {"status": "complete", "provider": "soilgrids", "resolution_m": 250, "origin": "dataset_estimate"},
  "live_weather": {"status": "complete", "provider": "open_meteo"},
  "drought":      {"status": "unavailable", "provider": null, "reason": "no_provider_for_region",
                   "reason_text": "No drought monitor is connected for this country."},
  "tools":        {"irrigation": "complete", "fertilizer": "partial"}}}
```

## 5. Farm and field batch analysis (A3, shipped)

`POST /v1/farms/analyze`:
```json
{"farm": {"farm_id": "f_7c1", "name": "Home farm", "fields": [
  {"field_id": "fld_1", "name": "North 40",
   "geometry": {"type": "Polygon", "coordinates": [[[-60.58, -33.88], [-60.57, -33.88], [-60.57, -33.89], [-60.58, -33.89], [-60.58, -33.88]]]},
   "plan": {"plan_id": "fld_1_plan", "previous_crop_id": "maize", "next_crop_id": "soybean", "prev_harvest": "04-20",
            "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "05-01", "terminate": "10-20"},
            "next_plant": "11-15", "grower": {"low_moisture_concern": null}},
   "goals": null}]},
 "options": {"prepare_weather": true, "wait_s": 0, "include_capabilities": true, "include_soil": false, "recommend": false}}
```
- 1–50 fields. `geometry` is a GeoJSON `Polygon` or `MultiPolygon` (holes allowed). `goals` is the §8 goals object (optional); with `options.recommend: true` a field with goals also gets `recommendation` (the §9 body without `meta`).
- `prepare_weather: true` starts one POWER fetch per cell with no stored weather; `wait_s` (0–120) waits for it. With 0 those fields come back `pending`; call again (or poll `GET /v1/weather/{cell_id}`) to get results.

Response:
```json
{"meta": {"plan_version": null, "catalog_version": "…", "snapshot_hash": null, "request_id": "…"},
 "farm_id": "f_7c1", "status": "complete",
 "fields": [{"field_id": "fld_1", "name": "North 40", "area_ha": 102.87, "area_ac": 254.2,
             "centroid": {"latitude": -33.89, "longitude": -60.58},
             "cell_id": "cell_-34.000_-60.625", "job_status": "ready", "status": "complete",
             "reason": null, "reason_text": null, "poll": null, "scope": "global", "snapshot_hash": "…",
             "capabilities": {"weather": {}, "catalog": {}, "soil": {}, "live_weather": {}, "drought": {}, "tools": {}},
             "result": {}}],
 "weather_cells": [{"cell_id": "cell_-34.000_-60.625", "field_ids": ["fld_1"], "job_status": "ready", "snapshot_hash": "…",
                    "cell": {"center": {"latitude": -34.0, "longitude": -60.625}, "size_deg": [0.5, 0.625], "note": "…"},
                    "note": "One NASA POWER weather series covers this whole cell."}],
 "totals": {"area_ha": 102.87, "area_ac": 254.2},
 "notes": ["A field is assigned to the weather cell that contains its centroid, …", "Only area is totalled. …"]}
```
- Area is geodesic, computed server-side with turf's formula (WGS84 radius 6378137 m); `area_ha`, `area_ac` and the centroid are rounded to 2 decimals. Geometry is never echoed or logged.
- `weather_cells[].note` is "These fields share one NASA weather series; differences between them come from their plans, not their weather." when a cell holds 2 or more fields.
- `capabilities` is B1's §4 `features` object (null when `include_capabilities: false`).
- `result` is the field's own compare entry (one item of `plans[]` in `POST /v1/plans/compare`, with the A2 fields `hemisphere`, `coverage`, `catalog`, `winter.season_label`, `spring.season_label`). It is null when the weather is `pending` or unavailable.
- Field `status`: the result's status; `unknown` while `job_status: pending`; `unavailable` with `reason` / `reason_text` (e.g. `offline_no_snapshot`, `power_unreachable`) when there is no weather. `scope` is `nc` (NC rules, 76.2 mm) or `global`.
- Top-level `status`: `complete` (every field complete), `unavailable` (none has weather), else `partial`. `meta.snapshot_hash` is null (a farm can span several snapshots; each field carries its own).
- `totals` holds area only. There is never a metric total.
- Invalid input is HTTP 400 `invalid_input` with issues naming the field: `farm.fields[<i>].geometry` with codes `self_intersection` ("Field 'Bowtie' crosses itself; redraw its boundary."), `invalid_geometry`, `invalid_ring`, `invalid_position`, `ring_not_closed`, `hole_outside`, `zero_area`, `too_many_vertices`, `crosses_antimeridian`; `farm.fields[<i>].field_id` `duplicate_field_id`; `farm.fields[<i>].plan.<field>` for plan errors.

The per-field drill-down uses existing endpoints with a `location` (`{latitude, longitude}` or `{cell_id}`; use the field's centroid or its `cell_id`): `POST /v1/plans/sensitivity`, `POST /v1/years` (`{plan, location}`) or `GET /v1/years?plan=&lat=&lon=` (sample plans), `GET|POST /v1/seasons/{year}/replay`. These work anywhere with stored weather. `POST /v1/plans/calendar|backup|note` and `POST /v1/plans/check|find` (Agent B) are still NC-only: outside NC they answer `status: unsupported`, `code: unsupported_location` until B generalises them.

Fields added by A2 (shipped). Everything else in the NC responses is byte-identical:
- Per plan (`plans[]` in compare): `hemisphere: "north" | "south"` (from the latitude), `coverage: {first_date, last_date, available_years, spring_available_years, off_season_available_years, cell_id}` (planting years whose full season / pre-plant window / off-season window are complete at this cell), and `catalog` (null in NC; outside NC the regional catalog state, today `{status: "unknown", reason: "no_regional_catalog", reason_text, origin: null, region_key: null}` until B2 lands).
- `plans[].winter.season_label`: `"Winter"` in NC, else `"Off-season (Apr–Nov)"` (months of `[previous harvest, planting)`). `plans[].spring.season_label`: `"30 days before planting"`. The field names stay `winter` / `spring`.
- Every threshold (`thresholds.heavy_rain`, `thresholds.dry_spring.*`) gains `location` (the cell id) and `origin` (`verified_source` for NC's published 76.2 mm, `calculation` otherwise). `threshold_set_id` is unchanged by these labels.
- `thresholds.heavy_rain.method`: `published_fixed` (NC, unchanged string) or `etccdi_r95p` outside NC: the cell's 95th percentile of wet days (≥ 1 mm), base 1981–2010, all months; `parameters.base_period`, `base_valid_days`, `base_expected_days`. If fewer than 25 of the 30 base years are present it is `status: insufficient_data`, `value: null`.
- `eras.*.status` is `insufficient_data` when an era has < 15 evaluable seasons (unchanged rule; now reachable for short records).
- Replay gains `hemisphere`, `winter.season_label`, `spring.season_label`. Sensitivity gains `catalog` and `season_label`; outside NC with no regional catalog it sweeps the weather only: `status: "unknown"`, `check_id: null`, `rule_ids: []`, and `checks_count` / `denominator` are `null` (never 0).
- `meta.catalog_version` outside NC is the regional catalog's (`none:…` while there is none), never NC's.

Location handling (A2):
- `location` accepts `{latitude, longitude}` or `{cell_id}` on compare, replay (POST), sensitivity and the new `POST /v1/years` (`{plan, location}`, for a field's own plan). `GET /v1/years` and `GET /v1/seasons/{year}/replay` accept `latitude`/`longitude`, the aliases `lat`/`lon`, or `cell_id`.
- A point in NC in a committed county cell behaves as before. Any other point uses its cell's stored weather (committed or A1 cache). A point outside NC is never given NC rules or NC's heavy-rain value, even inside an NC county's cell (a border cell: same weather series, different rules).
- No stored weather: NC keeps `no_weather_snapshot`; outside NC it is `status: unavailable` with `code`/`reason` `weather_not_prepared` (or `offline_no_snapshot` offline) and a `reason_text`. Call `POST /v1/weather/prepare` first. `unsupported_location` is now only for a `location_id` combined with a point outside NC (and, with B1, water or invalid points).

## 6. Regional profile and research (B2, B3)

`GET /v1/regions/{region_key}/profile`:
```json
{"meta": {}, "region_key": "AR-B", "status": "partial", "research": {"job_status": "ready", "generated_at": "…", "model": "claude-sonnet-5-5"},
 "crops": [{"crop_id": "soybean", "name": "Soybean", "roles": ["cash"],
            "calendar": {"plant": {"start": "10-15", "end": "12-31"}, "harvest": {"start": "03-15", "end": "05-31"},
                         "origin": "dataset_estimate", "source": {"title": "Sacks et al. 2010 crop calendar", "url": "…"}}}],
 "cover_crops": [{"crop_id": "cereal_rye", "origin": "ai_suggested", "sources": []}],
 "rotations": [{"label": "Maize → winter cover → soybean", "origin": "source_checked", "sources": []}],
 "rules": [{"rule_id": "ar_b_ai_007", "text": "…", "origin": "source_checked", "evidence_quote": "…",
            "source": {"title": "…", "url": "…", "locator": "…"}, "conflicts_with": [], "limitations": "…"}],
 "gaps": ["No local source found for cover termination timing before soybean."],
 "disclaimer": "AI-found suggestions to check with a local adviser; not verified advice."}
```
- NC (`US-NC`) gives `status: complete`, with every row `origin: verified_source`.

`POST /v1/regions/research` with body `{"region_key": "AR-B"}` (or a `location`) gives `{meta, job_id, job_status, region_key}`. `GET /v1/regions/research/{job_id}` gives the job status and, once ready, `profile_url`. With no API key it returns `job_status: failed`, `status: unavailable`, `reason: research_not_configured`.

## 7. Tools with area (B4)

`POST /v1/tools/fertilizer` and `POST /v1/tools/irrigation` accept an optional `area_ha` or `field_id` plus `farm`. They add `field_total {value, unit, origin: calculation}` and `units: "us|metric"`.

## 8. Goals, constraints, generation (P1)

`POST /v1/plans/generate`:
```json
{"location": {"latitude": 34.98, "longitude": -80.55},
 "field": {"field_id": "fld_1", "area_ha": 40.0, "crop_history": ["field_corn"], "soil": null},
 "goals": {"priorities": {"soil_cover": 3, "water_conservation": 2, "weather_resilience": 1, "crop_diversity": 0,
                          "living_cover_duration": 2, "management_simplicity": 1},
           "constraints": {"allowed_crops": null, "excluded_crops": ["winter_wheat"], "must_include": [],
                           "irrigation": "unknown", "equipment": ["no_roller_crimper"],
                           "latest_planting": "06-15", "earliest_harvest": null, "seasons": 2},
           "preferences": {"liked_crops": ["soybean"], "disliked_crops": []}}}
```
→ `{meta, status, candidates: [Plan + {candidate_id, seasons[], origins, checks_summary}], generation_log: [{rule|constraint, pruned, reason_text}], gaps: []}`

## 9. Recommendation (P2, shipped)

`POST /v1/plans/recommend`. Body: `{location? | location_id?, field?: {field_id, area_ha, crop_history, soil}, goals?: {priorities, constraints, preferences}, candidates?: [{candidate_id, label?, plans: [Plan, …1–4]}]}`.
- `goals.priorities`: only the six §8 names, integer weights 0–3 (an unknown name is a 400). With no non-zero priority every indicator is used with weight 1.
- Without `candidates`, candidates come from B's generator (P1). Until P1 lands: the NC preset rotations in NC (pruned by `excluded_crops`, `allowed_crops`, `must_include`, logged in `generation_log`), and `status: insufficient_data` with `gaps[]` elsewhere.
- Definitions, sources and the priority → indicator table: `backend/docs/indicators.md`.

```json
{"meta": {"plan_version": "<result_id>", "catalog_version": "…", "snapshot_hash": "…", "request_id": "…"},
 "status": "complete", "result_id": "…", "hemisphere": "north",
 "method": {"shortlist": "pareto_non_dominated", "ordering": "weighted_rank_positions",
            "indicators_used": ["living_cover_days", "bare_soil_days", "rain_on_bare_soil_mm"],
            "weights": {"living_cover_days": 3, "bare_soil_days": 3, "rain_on_bare_soil_mm": 3},
            "ordering_text": "…", "note": "Not universally optimal: depends on these priorities and this weather history.",
            "definitions": "backend/docs/indicators.md"},
 "shortlist": [{"candidate_id": "winter_cover", "label": "…", "origin": "assumed|grower|generated",
   "plans": [Plan, …], "leg_status": ["complete", "complete"],
   "indicators": {"rain_on_bare_soil_mm": {"value": 56.6, "unit": "mm per season", "direction": "lower_better",
        "origin": "calculation", "status": "complete", "reason": null, "definition": "…", "rationale": "…",
        "source": {"title": "…", "url": "…"}, "per_leg": [50.1, 63.1], "in_priorities": true}},
   "rank_positions": {"living_cover_days": 1, "bare_soil_days": 1, "rain_on_bare_soil_mm": 1},
   "wins": ["rain_on_bare_soil_mm", …], "loses": [],
   "why": [{"indicator": "rain_on_bare_soil_mm", "text": "…", "value": 56.6, "source": {}, "audit_id": "…"}],
   "trade_offs": [{"versus": "current_practice", "text": "…",
                   "worse_on": [{"indicator": "rule_flags", "value": 22, "versus_value": 14, "in_priorities": false}]}],
   "uncertainties": [{"text": "…", "origin": "nasa_modeled"}],
   "historical_vulnerabilities": [{"year": "2025", "indicator": "rain_on_bare_soil_mm", "plan_id": "corn_soy__rye",
        "value": 208.2, "field": "rain_outside_cover_mm", "text": "…",
        "replay": {"method": "POST", "path": "/v1/seasons/2025/replay", "body": {"plan": {}, "location_id": "union"}}}]}],
 "not_comparable": [{"candidate_id": "c9", "status": "partial", "missing": ["rule_flags"], "indicators": {}, "plans": []}],
 "dominated": [{"candidate_id": "current_practice", "dominated_by": ["add_grain_crop", "winter_cover"], "indicators": {}, "plans": []}],
 "thresholds": {}, "context": {"soil": null, "soil_note": null},
 "generation_log": [{"constraint": "crops", "pruned": "add_grain_crop", "reason_text": "…"}], "gaps": [],
 "weather_location": {}}
```
- Indicator names: `rain_on_bare_soil_mm`, `heavy_rain_days_on_bare_soil`, `dry_pre_plant_frequency` (its `per_leg` items are `{value, dry_seasons, eligible_seasons}`), `modeled_root_zone_wetness_at_planting` (`origin: nasa_modeled`), `living_cover_days`, `bare_soil_days`, `crop_family_diversity` (`detail.families`), `rule_flags` (`detail.rule_ids`; `null` + `status: unknown` where no rules are loaded), `management_operations`, `irrigation_dependence` (always `null`, `status: unknown`: no sourced data yet).
- A multi-season candidate's value is the mean of its legs (`per_leg` lists them). Never a sum, never a score: no field anywhere is a composite number. `rank_positions` are per indicator, within the shortlist.
- `wins` / `loses` / `why` compare with every comparable candidate (shortlisted and dominated). `trade_offs` include indicators outside the priorities, marked `in_priorities: false`.
- `historical_vulnerabilities[].replay` is a ready request: `{method: "POST", path, body: {plan, location_id | location}}` with the same place as the recommendation (NC place id, cell id, or a 2-decimal point).
- `rule_flags` is checks **per season** (mean over legs); `detail.rule_ids` and `detail.unknown_rule_ids` list them. A requested indicator that is unknown makes that candidate `not_comparable`.
- `status`: `complete`, `partial` (some candidates not comparable), `insufficient_data` (no candidates / none comparable, see `gaps`), or `unavailable` (no stored weather: `code`, `reason_text`, `weather_location`, as for compare).

## 10. Future farm plan (P3)

`POST /v1/plans/future` with body `{location, plan | candidate, start_season: "2027", seasons: 2, edits?: [{field, value}]}` gives:

`{meta, status, seasons: [{season: "2027", windows: [{kind, start, end, origin, source?}], cover_schedule, milestones: [{date, label, origin}], decision_deadlines: [{date, decision, switch_condition, next_check_date}], warnings: [], historical_vulnerabilities: [], backup: {}}], diff?: {changes: []}, recommendation_refresh?: {}}`

---

# Scenario Simulator contract (S-cards; see `docs/global/simulator.md`)

Common: every response has `meta`, the 9 status words, `origin` on every value, `null` for blanks, and money as `{value, currency, unit, origin, source?}`. `currency` is the location's currency where a source gives it, else `USD`; area units are `acre | ha` (US default acre, elsewhere ha).

## 11. Simulate and compare scenarios (S1, S2; shipped)

`POST /v1/scenarios/simulate`:
```json
{"location": {"latitude": 34.98, "longitude": -80.55},
 "field": {"field_id": "fld_1", "name": "North 40", "area_ha": 16.2, "geometry": null,
           "equipment": ["planter", "grain_drill", "sprayer", "combine"],
           "readings": [{"date": "2026-04-02", "kind": "soil_moisture_pct", "value": 23.5, "depth_cm": 10}]},
 "goals": {"priorities": {"soil_cover": 2, "water_conservation": 2, "weather_resilience": 1, "crop_diversity": 1,
                          "living_cover_duration": 1, "management_simplicity": 1, "profit": 3}},
 "economics": {"overrides": {"soybean": {"price": {"value": 11.2, "unit": "USD/bu"}, "yield": {"value": 48, "unit": "bu/acre"}}},
               "loss_assumptions": {"dry_spring_pct": 15, "heavy_rain_pct": null}},
 "scenarios": [
   {"scenario_id": "current", "label": "What I do now", "is_baseline": true,
    "rotation": [/* 1..4 Plan objects (one per season of the rotation), cycled over the years */]},
   {"scenario_id": "s2", "label": "Add cereal rye", "rotation": []}],
 "years": 10, "runs": 200, "seed": 7, "start_season": "2027", "climate": "trend"}
```
Response:
```json
{"meta": {}, "status": "complete",
 "method": {"weather": "historical_resampling", "runs": 200, "seed": 7, "source_years": "1981-2025",
            "note": "An evidence-based outlook: this field's real past seasons (1981-2025) replayed in new orders over the next 10 seasons. Rain is adjusted for the trend observed in this record. It shows what to plan for under conditions seen here; it cannot say what any single year will bring."},
 "scenarios": [{"scenario_id": "current", "label": "What I do now", "status": "complete",
   "timeline": [{"year": 2027, "season": "2027", "crop_sequence": ["field_corn", "cereal_rye", "soybean"], "plan_id": "…"}],
   "yearly": [{"year": 2027,
               "indicators": {"rain_on_bare_soil_mm": {"p10": 40.1, "median": 78.0, "p90": 140.2, "unit": "mm", "origin": "calculation"},
                              "living_cover_days": {"median": 211, "unit": "days", "origin": "calculation"},
                              "dry_pre_plant": {"probability": 0.21, "origin": "calculation"}},
               "money": {"revenue": {"p10": null, "median": 41200, "p90": null, "currency": "USD", "origin": "calculation"},
                         "costs": {"median": 28100, "currency": "USD", "origin": "calculation"},
                         "margin": {"p10": 9800, "median": 13100, "p90": 16900, "currency": "USD", "origin": "calculation",
                                    "includes_assumption": "dry_spring_pct"}}}],
   "totals": {"margin_10y": {"p10": 98000, "median": 131000, "p90": 165000, "currency": "USD", "origin": "calculation"},
              "living_cover_days_per_year": {"median": 190}, "rain_on_bare_soil_mm_per_year": {"median": 260.4},
              "crop_families": 3, "operations_per_year": 6.5},
   "events": [{"event": "dry_springs_ge_3_in_10y", "probability": 0.34, "text": "3 or more dry springs in 10 years in 34% of replays"}],
   "money_status": "complete", "money_gaps": [],
   "readings_context": [{"date": "2026-04-02", "kind": "soil_moisture_pct", "value": 23.5, "origin": "grower",
                         "modeled_same_day": {"gwettop": 0.41, "origin": "nasa_modeled"}}]}],
 "comparison": {
   "baseline": "current",
   "badges": [{"badge": "best_profit", "scenario_id": "s2", "why": "Highest median 10-year margin: $142,000 vs $131,000."},
              {"badge": "most_sustainable", "scenario_id": "s2", "why": "…"},
              {"badge": "lowest_weather_risk", "scenario_id": "current", "why": "…"},
              {"badge": "best_for_priorities", "scenario_id": "s2", "why": "…"}],
   "deltas": [{"scenario_id": "s2", "versus": "current", "changes": [{"indicator": "margin_10y", "median_delta": 11000, "currency": "USD", "text": "+$11,000 over 10 years (median)"}]}],
   "trade_offs": [{"scenario_id": "s2", "text": "More cover days but one more field operation a year."}],
   "caveat": "The stronger of the plans you compared, given these numbers and the conditions seen at this field. An evidence-based outlook, not a guarantee."}}
```
- A badge is omitted when it can't be decided fairly. For example, `best_profit` needs money for every scenario; otherwise it is left out and the reason goes in `comparison.not_decided[]`.
- At most 6 scenarios, 1–10 years and 50–500 runs. Rate class: analysis.

**As shipped (S1, S2, 2026-11-14).** Frozen examples: `simulate_union` (money and a loss assumption), `simulate_union_no_money`, `simulate_pergamino` (the prepared cell, no money), `simulate_invalid_runs` (400). Where this list and the draft above differ, this list is right.
- Request:
  - `field.area_ha`, or `field.geometry` (the backend measures it; `field.area_origin` says which). With neither, there is no money result (`money_gaps[].reason: "no_area"`).
  - `economics.overrides[crop]`: any of `price {value|typical, low?, high?, unit: "USD/bu"}`, `yield {value, unit: "bu/acre" | "t/ha"}`, `costs` (`{value, unit: "USD/acre"}`, `{total: {value, unit}}` or a list of `{item, value, unit}`). The price unit's quantity must match the yield's (`USD/bu` with `bu/acre`); otherwise it's a `unit_mismatch` gap, never a guess.
  - `economics.loss_assumptions`: `dry_spring_pct`, `heavy_rain_pct` (0–100 or null). No other keys.
  - `goals.priorities` accepts `profit` (and `/v1/plans/recommend` now accepts and ignores it).
  - No `is_baseline`: the first scenario is the baseline. Two baselines, or duplicate ids: 400.
- `method`:
  - `{weather: "historical_resampling", runs, seed, years, start_season, source_years, pool_years, note, draws, threshold_set_id, resolution, money_source}`.
  - `pool_years` is the number of past seasons in which every plan of every scenario can be evaluated. Fewer than 15: `status: "insufficient_data"` with an empty `scenarios`.
  - `climate_adjustment`: from the request field `climate`, `"trend"` (default) or `"none"`. With `"none"` it is `{mode: "none"}`. With `"trend"` it is `{mode: "trend", target_year, alpha, applied, reason, precip_trend, temperature_trend, factor_range, note, text, origin}`: the Theil-Sen trend in this field's own record (Mann-Kendall test), carried to the middle of the outlook. Rain in every replayed season is rescaled by it only when the rain trend is statistically clear (`applied: true`); the temperature trend is context only. `text` says in plain language what was found and done. `reason` is `insufficient_years` or `no_significant_precip_trend` when nothing was applied. The simulator is an evidence-based outlook (what was observed at the field plus its trend, carried through the next N seasons), not a forecast of any single year; `note` says so, and adds a rain-adjustment sentence when `applied` is true.
  - `draws` says that every scenario replays the same past seasons in each run (common random numbers).
  - `money_source` is `economics_library` (B's S3: your values first, then sourced references) or `grower_only`.
- `scenarios[]` adds `is_baseline`, `money_status` (`complete | partial | unavailable`), `money_gaps[{crop_id?, field, reason, text}]` and `replayed_seasons_sample` (the past years replayed in run 0).
- `yearly[].indicators`:
  - `rain_on_bare_soil_mm` and `heavy_rain_days_on_bare_soil`: `{p10, median, p90, unit, origin}`.
  - `living_cover_days`: `{median, unit, origin, planned: true}`.
  - `dry_pre_plant`: `{probability, origin}`.
  - `operations`: `{value, unit, origin}`.
  - These are P2's definitions (`backend/docs/indicators.md`).
- `yearly[].money`:
  - `{revenue, costs, margin}`, each `{p10, median, p90, currency, origin}`; null when `money_status` isn't complete.
  - `includes_assumption` is `null`, `"dry_spring_pct"`, `"heavy_rain_pct"` or `"dry_spring_pct+heavy_rain_pct"`.
  - A loss is applied only to the crop planted after the event, and only in replayed years when that event happened.
- `totals`:
  - Distributions: `rain_on_bare_soil_mm_per_year`, `heavy_rain_days_on_bare_soil_per_year`, `dry_springs` and `stress_events` (dry pre-planting windows plus years with heavy rain on bare soil). The last two add a `mean`.
  - Values: `living_cover_days_per_year {median}`, `crop_families` (null when a crop has no family) with `crop_families_detail`, and `operations_per_year`.
  - With money:
    - `margin_10y {p10, median, p90, currency, origin, includes_assumption}` covers the requested number of years.
    - `margin_10y_price_cases {low, typical, high}` appears only when every revenue crop has a sourced price range.
    - `weather_link` says whether money moved with weather (`none` without a loss assumption).
- `events[]`:
  - `dry_springs_ge_3_in_<N>y` and `heavy_rain_on_bare_soil_years_ge_3_in_<N>y` (when N ≥ 3).
  - `back_to_back_dry_springs` (when N ≥ 2).
- `readings_context[]` (the same in every scenario): each reading as sent plus `origin: "grower"` and:
  - `modeled_same_day` (`{gwettop | precip_mm | tmean_c, origin: "nasa_modeled"}`), or null with `modeled_same_day_reason` when the date is outside the record;
  - `modeled_typical_for_date` (`{variable, p10, median, p90, years, origin, note}`).
  - Readings never enter the run.
- `crop_money`: per crop `{status, currency, price {low, typical, high, origin}, yield_per_area, costs_per_area}`, as used.
- `comparison`:
  - `badges[{badge, scenario_id, why}]`.
  - `not_decided[{badge, reason: money_missing | tie | indicator_missing | only_one_scenario, text}]`.
  - `deltas[{scenario_id, versus, changes[{indicator, delta | median_delta, currency?, text}]}]`.
  - `trade_offs[{scenario_id, better[], worse[], text}]`.
  - `caveat`.
- Badge rules:
  - `best_profit`: highest `margin_10y.median`, only when every scenario has one.
  - `most_sustainable`: non-dominated on living-cover days, rain on bare soil and crop families, ordered by rank positions.
  - `lowest_weather_risk`: lowest mean `stress_events`.
  - `best_for_priorities`: P2's method, using rank positions only. Each priority's weight is shared among the metrics it names: `soil_cover` covers cover days and rain on bare soil; `water_conservation` covers heavy-rain days on bare soil; `weather_resilience` covers stress events; `crop_diversity` covers families; `living_cover_duration` covers cover days; `management_simplicity` covers operations; `profit` covers `margin_10y`.
  - A tie is never broken arbitrarily; it goes in `not_decided`.
- No weather for the point: HTTP 200 `{status: "unavailable", code, reason, reason_text, weather_location, scenarios: [], comparison: null}`, as compare does.

## 12. Economics estimate (S3)

`POST /v1/economics/estimate` with body `{location, crops: ["field_corn", "soybean"], area: {value, unit}, equipment: [], overrides: {}}`:

```json
{"meta": {}, "currency": "USD", "area_unit": "acre",
 "crops": [{"crop_id": "soybean",
   "price": {"low": 9.5, "typical": 11.2, "high": 13.6, "unit": "USD/bu", "origin": "verified_source",
             "source": {"title": "USDA NASS Agricultural Prices", "url": "…", "years": "2021-2025"}},
   "yield": {"value": 44, "unit": "bu/acre", "origin": "dataset_estimate", "source": {"title": "USDA NASS county yields", "year": 2024}},
   "costs": {"items": [{"item": "seed", "value": 62, "unit": "USD/acre", "origin": "verified_source", "source": {}}],
             "total_per_area": {"value": 410, "unit": "USD/acre"}},
   "status": "complete"}],
 "equipment_costs": [{"equipment": "grain_drill", "pass": "drill", "value": 18.5, "unit": "USD/acre", "origin": "verified_source"}],
 "gaps": []}
```
A crop with no source and no override gets `status: "unavailable"`, null values and a `reason_text`.

Sourced yields and cost totals may carry `area_basis: harvested|planted|unknown`. Conflicting
known bases leave margin blank with a reason; no area-basis conversion is assumed. Exact mass
and area unit conversions are supported; bushel-to-mass conversions are not inferred.

## 13. Crop library (S4)

- `GET /v1/crops/search?q=okra&region_key=US-NC` returns `{meta, results: [{crop_id, name, family, roles, origin, has_calendar, has_economics, region_note}], can_research: true}`.
- `POST /v1/crops/research` with body `{name: "okra", region_key: "US-NC"}` returns `{meta, job_id, job_status, crop_id?}`.
- `GET /v1/crops/research/{job_id}` returns the job, and once ready the `crop`.
- `GET /v1/crops/{crop_id}?region_key=` returns `{crop_id, name, scientific_name, family, roles, season_length_days, calendars: [{region_key, plant, harvest, origin, source}], economics_refs: [], origin, sources[], cached_at}`.

The library is shared by all users (cached centrally). Every research call goes through the guardrails, research caps and rate limits. The request carries only the crop name and region.

**Shipped (S4).** Crop details also carry `aliases`, `researched`, `in_sage` and `notes`.
Calendars include `review` and `sage_check`. Economics references include `used_for_money`;
AI references are never used for money. Research jobs carry `name`, `region_key`, `status`,
`reason`, `reason_text` and an optional `check`. A known crop or cached answer can be ready
without a new AI call. Crop research shares the regional-research rate limit and daily budget.

## 14. Field context: equipment and readings (S5)

The field object in §11/§5 gains:
- `equipment[]`, from the vocabulary `planter, grain_drill, no_till_drill, broadcast_seeder, sprayer, roller_crimper, disk, chisel_plow, field_cultivator, combine, forage_harvester, irrigation_pivot, irrigation_drip, irrigation_none, other:<text>`;
- `readings[]`: `{date, kind: soil_moisture_pct | soil_moisture_vwc | rainfall_mm | soil_temp_c | note, value, depth_cm?, note?}`.

Both stay in the browser and are sent per request, never stored on the server. `GET /v1/vocab/equipment` and `GET /v1/vocab/readings` return the vocabularies with labels.

`POST /v1/seasons/{year}/replay` accepts `field: {equipment, readings}` and returns
`readings_context`, including available same-day modeled context. Readings do not change the
NASA series or replay metrics. Farm analysis accepts the same field context and returns it
per field; equipment is passed to the recommendation feasibility check.

## 15. Demo and autofill (S6)

- `GET /v1/demo/farm?scenario=union|pergamino` returns `{meta, farm: Farm (contract §5 shape plus equipment and readings), current_plans, economics_overrides, goals, label: "Demo farm (example values)"}`.
- `POST /v1/plans/autofill` with body `{location, crops: [{role: "previous|cover|next", crop_id}]}` returns `{meta, plan: Plan, dates: [{field, value, origin, source}], gaps}`.

**Shipped (S6).** Both demo farms contain two synthetic fields with geometry, measured area,
equipment and example readings. `current_plans[field_id]` contains a two-season rotation.
`economics_overrides` contains explicit example inputs, labelled not sourced; there is no
default weather-loss assumption. `note`, `economics_note` and `resolution_note` describe the
synthetic inputs, historical replay and shared NASA cell.

Autofill accepts a point or `cell_id`, one previous crop, one next crop and an optional cover.
The response adds `status` and `note`; each date adds `status`. Missing dates have null values
and origins, with `{field, reason, text}` entries in `gaps`. An incomplete or invalid calendar
has `plan: null`. NC catalog windows apply only within their NC region; other planting and
harvest dates use the local SAGE calendar. Unsourced cover spacing is labelled `assumed`.

## 16. Vocabularies

`GET /v1/vocab/priorities` returns the priority list, now including `profit`, with plain labels and one-line explanations for the UI.

**Shipped (A):** `{meta, status, priorities: [{priority_id, label, explanation, weights: {min: 0, max: 3}, used_by: ["simulate", "recommend"?]}]}`. `profit` is used by simulate only. Example: `vocab_priorities`.
