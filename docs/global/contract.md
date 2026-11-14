# Global API contract (draft, G0)

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
