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
{"cell_id": "lat-34.00_lon-60.625"}                  // a POWER grid cell
```
Existing endpoints that take `location` keep their old behaviour when it is omitted (the NC demo).

## 2. Weather on demand (A1)

`POST /v1/weather/prepare` with body `{"location": Location, "refresh": false}`:

```json
{"meta": {}, "cell_id": "lat-34.00_lon-60.625", "job_status": "ready",
 "status": "complete", "reason": null, "reason_text": null,
 "source": "committed|cache|fetched", "snapshot_hash": "…", "retrieved_at": "2026-11-14T15:02:11Z",
 "cell": {"center": {"latitude": -34.0, "longitude": -60.625}, "size_deg": [0.5, 0.625],
          "note": "One NASA POWER weather series covers this whole cell."},
 "coverage": {"first_date": "1981-01-01", "last_date": "2026-11-10", "complete_pre_plant_windows": null,
              "complete_years": 45, "missing_days": {"PRECTOTCORR": 0}, "status": "complete"}}
```
- `job_status: "pending"` returns `poll: "/v1/weather/{cell_id}"`.
- `failed` returns `status: "unavailable"` with a reason such as `power_unreachable` or `offline_no_snapshot`.

`GET /v1/weather/{cell_id}` returns the same body.

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
 "cell_id": "lat-34.00_lon-60.625",
 "region_keys": ["AR-B", "AR", "koppen:Cfa"],
 "nc_region": null}
```
`nc_region` is `"Piedmont"`, `"Coastal Plain"` or `"Mountains"` inside NC.

## 4. Capabilities (B1; A3 embeds it per field)

`GET /v1/locations/capabilities?lat=&lon=`:
```json
{"meta": {}, "region_key": "AR-B",
 "features": {
  "weather":      {"status": "complete", "job_status": "ready", "cell_id": "…", "origin": "nasa_measured"},
  "catalog":      {"status": "partial", "origin": "ai_suggested", "region_key": "AR-B",
                   "reason_text": "Suggestions found by AI research; check them with a local adviser."},
  "soil":         {"status": "complete", "provider": "soilgrids", "resolution_m": 250, "origin": "dataset_estimate"},
  "live_weather": {"status": "complete", "provider": "open_meteo"},
  "drought":      {"status": "unavailable", "provider": null, "reason": "no_provider_for_region",
                   "reason_text": "No drought monitor is connected for this country."},
  "tools":        {"irrigation": "complete", "fertilizer": "partial"}}}
```

## 5. Farm and field batch analysis (A3)

`POST /v1/farms/analyze`:
```json
{"farm": {"farm_id": "f_7c1", "name": "Home farm", "fields": [
  {"field_id": "fld_1", "name": "North 40",
   "geometry": {"type": "Polygon", "coordinates": [[[-60.58, -33.88], [-60.57, -33.88], [-60.57, -33.89], [-60.58, -33.89], [-60.58, -33.88]]]},
   "plan": {"plan_id": "fld_1_plan", "previous_crop_id": "maize", "next_crop_id": "soybean", "prev_harvest": "04-20",
            "winter": {"kind": "cover", "crop_id": "cereal_rye", "seed": "05-01", "terminate": "10-20"},
            "next_plant": "11-15", "grower": {"low_moisture_concern": null}}}]},
 "options": {"include_soil": true, "prepare_weather": true}}
```
Response:
```json
{"meta": {}, "status": "partial",
 "fields": [{"field_id": "fld_1", "name": "North 40", "area_ha": 101.3, "area_ac": 250.3,
             "centroid": {"latitude": -33.89, "longitude": -60.58},
             "cell_id": "lat-34.00_lon-60.625", "job_status": "ready",
             "capabilities": {},
             "result": {}}],
 "weather_cells": [{"cell_id": "lat-34.00_lon-60.625", "field_ids": ["fld_1"],
                    "note": "These fields share one NASA weather series; differences between them come from their plans, not their weather."}],
 "totals": {"area_ha": 101.3, "area_ac": 250.3}}
```
- `capabilities` is the §4 `features` object.
- `result` has the same shape as one entry of `plans[]` in `POST /v1/plans/compare`, plus `hemisphere` and `season_label`.
- A field whose weather is still pending has `job_status: "pending"` and `result: null`.
- `totals` holds area only. There is never a metric total.

The per-field drill-down uses existing endpoints with a `location` added: `POST /v1/plans/sensitivity`, `GET /v1/years?plan=&lat=&lon=`, `GET|POST /v1/seasons/{year}/replay`, `POST /v1/plans/calendar|backup|note`, `POST /v1/plans/check|find`.

Fields added to compare output (A2):
- `hemisphere: "north|south"`.
- `winter.season_label` (e.g. "Off-season (May–Oct)"; it stays "Winter" for NC) and `spring.season_label` ("30 days before planting").
- `thresholds.*.location`, `thresholds.*.origin` and `thresholds.heavy_rain.method` (`fixed_published` | `etccdi_r95p`).
- `eras[].status` can be `insufficient_data`.
- `coverage.available_years`.

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
