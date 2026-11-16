# A.C.R.E goes global: plan and phase cards

**Goal.** A farmer anywhere finds their farm on a map, draws their fields, gives each field its own rotation and dates, and gets an auditable historical stress test from decades of NASA weather and the published guidance for that place. It stays a historical stress test, never a forecast or yield tool, and keeps every existing NC feature, test and the offline demo.

Rules: `CLAUDE.md` (root). API shapes: `docs/global/contract.md`. Status and handoffs: `docs/global/log-<agent>.md`.

---

## What already exists, and what each proposal needs

| Proposal | Already there | Work |
|---|---|---|
| 1 Global location | Per-location snapshots + index (8 NC counties), POWER client and snapshot builder, cell ids, location resolve (NC outline only) | **Extend.** On-demand POWER fetch and cache (A1). Worldwide geocode, reverse geocode, climate class, capabilities (B1). Map search (C1) |
| 2 Map and boundaries | Nothing (NC outline picker, generic 3D rectangle) | **New.** MapLibre map, drawing, GeoJSON, browser storage (C1–C2). 3D field from polygon (C3) |
| 3 Field-level planning | Plans are already independent objects; compare takes many plans | **Extend.** Farm and field batch API (A3). Field state and screens (D1–D2) |
| 4 AI research | Catalog row schema with source, locator, verified date; rule engine already returns `manual_check` and `unknown` for anything it can't evaluate | **New.** Research pipeline that writes catalog rows plus a code check of each quote (B3) |
| 5 Regional catalogs | v1/v2 NC catalogs, loader, index, rule engine with region checks (`field/regions.py`) | **Extend.** Catalog v3 superset, region keys, profiles, SAGE crop calendars, location to catalog lookup (B2) |
| 6 Global analysis | Season windows are cycle-based (any month, crossing years); thresholds frozen per location; eras fixed at 1981–2000 vs 2006–2025 | **Extend.** Coverage-aware eras, hemisphere-neutral labels, local heavy-rain method outside NC, any crop id (A2) |
| 7 Soil and live data | USDA SDA, NWS, USDM (US only) | **Extend.** SoilGrids, Open-Meteo, area in tools (B4) |
| 8 Location-aware experience | NC dashboard and pages, Extension summary | **Extend.** Onboarding through the map, capabilities panel, field switcher, farm overview (D1–D3) |
| 9 Safeguards | Blank vs zero, status vocabulary, audit entries, hashes, log scrubbing, offline mode | **Keep and extend.** `origin` provenance on every value, resolution notices, privacy rules (all cards; checked in A4 and D4) |

## Key decisions (made; change them only through Rahul)

- **Weather:** NASA POWER daily (same parameters as Phase 1), fetched once per grid cell on demand, saved in the existing snapshot format with a manifest and hash in `ACRE_CACHE_DIR` (a Railway volume). Committed NC snapshots always win. A cached cell is never refreshed silently. Offline mode reads committed and cached data only.
- **Thresholds outside NC:** dry spring = bottom 20% of the cell's own 1981–2025 windows (same method as NC). Heavy rain in NC stays the published 76.2 mm. Outside NC it is the cell's own 95th percentile of wet days (≥ 1 mm) over the 1981–2010 base. That is the ETCCDI R95p definition, labelled `origin: calculation`, `method: etccdi_r95p`. Both are frozen per cell.
- **Eras:** fixed 1981–2000 vs 2006–2025, each needing ≥ 15 of 20 evaluable seasons, else `insufficient_data`. Never shifted silently. Coverage is reported per cell.
- **Seasons:** the existing "winter" window `[prev_harvest, plant)` is the **off-season** window and works in either hemisphere. API field names stay the same. New `season_label` and `hemisphere` fields carry the wording. The "spring" window is the 30-day pre-planting window everywhere.
- **Geocoding:** Nominatim (OpenStreetMap) behind the backend, with a generic User-Agent, at most 1 request per second, and caching. Free text and coordinates are both accepted.
- **Climate class:** Köppen–Geiger (Beck et al. 2023, 1991–2020, CC BY 4.0), bundled and downsampled to ≤ 5 MB, with its resolution reported.
- **Crop calendars:** SAGE / Sacks et al. (2010) gridded planting and harvest dates (0.5°, 19 crops), bundled and preprocessed (≤ 5 MB), labelled `dataset_estimate`.
- **AI research:** the Claude API (default model `claude-sonnet-5-5`, configurable) with web search and fetch. It outputs catalog v3 rows plus a profile. A code step fetches each cited page and looks for the quoted text, giving `source_checked` or `ai_suggested`. Results are cached per region key. It needs `ANTHROPIC_API_KEY`; without one, research is `unavailable` and the SAGE-only profile is used. Tests never call it.
- **Soil:** USDA SDA in the US; SoilGrids v2 (250 m) elsewhere and as the US fallback. **Live weather:** NWS in the US; Open-Meteo elsewhere, as context only. **Drought:** USDM in the US, otherwise `unavailable`.
- **Map:** MapLibre GL JS with Esri World Imagery (satellite, with attribution) and OSM (streets), drawing with terra-draw, measurements with turf. No map key needed.
- **Storage:** no accounts and no database. Farms live in browser `localStorage` (versioned) with GeoJSON import and export. The backend stores no farm data. Only the weather, soil, geocoder and research caches are on disk.

## Product focus (2026-11-14 follow-up; overrides earlier emphasis)

A.C.R.E's central question is: *"Given my farm's location, soil, crops, historical weather and my own goals, which future crop-rotation plans suit it best, why should I consider them, and how do I carry them out?"* Historical stress testing **supports** that decision. It is not the product. Future planning, rotation generation, farmer priorities and explainable recommendations (cards **P1–P6** below) come before cosmetic work and before the rest of the geographic expansion.

What already exists for this:
- The plan finder (`planner/finder.py`, Phase 7) searches only predefined options.
- The checker validates one plan.
- The calendar and backup cover one season.
- The frontend's priority picker (3 fixed priorities) only reorders cards.

What's missing:
- Generating candidates.
- Weighted goals and hard constraints.
- Multi-objective evaluation.
- Soil-health and water indicators.
- A multi-season future plan.

**Hard rules for P1–P6:**
- No single made-up score.
- A recommendation is a shortlist of non-dominated plans (Pareto) over named indicators. The farmer's weights only order and explain that shortlist; they never invent a number.
- Every indicator has a documented definition and source.
- Expected benefits (soil health, water) are labelled as **indicators** drawn from sourced principles, never as measured outcomes.
- No erosion, yield, soil-health improvement or water-saving figures, ever.
- Where the regional evidence is too thin to generate options, return `insufficient_data` with the gaps, not a guess.

## Fast path (2026-11-14, overrides the wave order below)

- **Core, in order.** A: A1 ✓ → A2 → P2 → A3 → A4 (A4 reduced to a contract refresh and a smoke test). B: B1 ✓ → B2 → P1 → P3.
- **Optional, only after the core is pushed:** B3 (AI research) and B4 (global soil, live weather, tools with area).
- P2 builds against B's real `generate_candidates()` as soon as B announces it in `log-B.md`. Until then it stubs it with the NC presets.

## Waves (cards in the same wave run in parallel)

| Wave | A (backend) | B (backend) | C (frontend) | D (frontend) | Merge to main |
|---|---|---|---|---|---|
| 1 | **A1** global weather on demand | **B1** geo and capabilities | **C1** map, search, pick a point | **D1** app shell, farm state, adapter (against contract fixtures) | after wave 1 |
| 2 | **A2** location-generic analysis | **B2** regional catalogs and SAGE | **C2** farm and field editor, GeoJSON, storage | **D2** field-level planning screens | after wave 2 |
| 3 | **P2** indicators and Pareto evaluation (A) | **P1** goals, constraints and rotation generator (B) | **P4** goals and constraints UI (Abhi, after C2/D2) | | after wave 3 |
| 4 | **A3** farm and field batch API (now also carries goals per field) | **P3** future multi-season farm plan (B) | **P5** options and recommendation screens (Abhi) | | after wave 4 |
| 5 | **A4** contract freeze, deploy, smoke | **B3** AI regional research, then **B4** soil, live, tools | **P6** future plan editor (Abhi), then **C3/C4/D3** | **D4** integration, full-workflow e2e, release (Abhi) | release |

**Frontend owner change (2026-11-14):** Abhi took over all frontend cards from Agents C and D (they ran out of usage). Their unfinished work is on `frontend/dev` (`fe03061` C, `e68a2e9` D). Abhi's order: finish C1 fixes → D1 → C2 → D2 → P4 → P5 → P6 → C3/C4/D3 → D4. Read "C" and "D" in the rest of this file as Abhi.

Sync points (pull, don't reimplement):
1. Everyone starts from the G0 contract. When a backend card changes a shape, A updates `docs/global/contract.md` and logs it. B posts its shapes in `log-B.md`, and A folds them in.
2. A2, A3 and P2 call B's `catalog_for_location()` (B2); P2 consumes P1's candidates through `generate_candidates()` (stub with the NC presets until P1 lands). Until B2 lands, A uses the NC v2 catalog for NC and an empty catalog elsewhere (all rules `unknown`).
3. A3's per-field capabilities call B's `capabilities_for()` (B1).
4. D works against fixtures built from the contract in `web/src/api/fixtures/`. It swaps to the live API when the matching backend card is pushed: `git merge origin/backend`, run the backend locally.
5. C owns `web/src/farm/types.ts` (the Farm and Field model, drafted in G0). D imports it and never edits it.

---

## G0: setup (Rahul's session, done)

A.C.R.E is the remote, and the backend is merged into `main`. The branches are `backend` (A, B) and `frontend/dev` (C, D) in two worktrees. This file, `contract.md`, the agent logs, the root `CLAUDE.md` and `web/src/farm/types.ts` are in place.

---

## A1 — Global weather on demand (A, wave 1, critical path)

Build:
- `acre/weather/ondemand.py`, using this lookup order for a lat/lon:
  1. the committed snapshot index;
  2. the cache `ACRE_CACHE_DIR/weather/<cell_id>/`;
  3. a POWER fetch: same parameters and community as Phase 1, from 1981-01-01 to the last complete day POWER serves.
  Write the result with the existing `write_snapshot` (manifest, raw, daily, hash) and record `retrieved_at` and the source URL.
- One fetch per cell at a time (dedupe concurrent requests), a timeout, one retry. Failures give `status: unavailable` with `reason` and `reason_text`.
- Coverage per cell: first and last date, complete springs and off-seasons, missing days per parameter, and `status` = `complete` (≥ 40 complete years), `partial`, or `insufficient_data` (< 15).
- Endpoints `POST /v1/weather/prepare` and `GET /v1/weather/{cell_id}` (contract §2), with `job_status: pending|ready|failed`.
- `ACRE_OFFLINE=1`: never fetch. A cell that isn't stored gives `unavailable` / `offline_no_snapshot`.
- `refresh: true` is the only way to re-fetch. A refresh writes a new hash and never rewrites the old one.

Accept:
- Mocked POWER: a first `prepare` fetches and caches; a second makes no network call and returns the same hash.
- Two concurrent prepares for one cell cause one fetch.
- POWER down gives `unavailable` and no partial files left behind.
- Offline with no cache gives `offline_no_snapshot`.
- The 8 NC snapshots resolve without the cache, and the NC example outputs are byte-identical.
- A recorded real POWER response for one Southern Hemisphere cell (Pergamino, AR, −33.89, −60.57; public NASA data, labelled) is committed as a test fixture under `backend/tests/fixtures/power/`.

## A2 — Location-generic analysis (A, wave 2)

Build:
- Every analysis entry point (compare, replay, sensitivity, years, and the library calls B's Phase 9 code uses) takes `location` (lat/lon or `cell_id`) and uses A1's snapshot for it. NC sample behaviour is unchanged.
- Thresholds frozen per cell:
  - Dry spring: same method as NC.
  - Heavy rain: 76.2 mm inside NC; `etccdi_r95p` (base 1981–2010, wet day ≥ 1 mm) outside NC, labelled.
  - Every threshold carries `location` and `origin`.
- Coverage-aware eras: each era is evaluated only with ≥ 15 evaluable seasons, else `insufficient_data`. Report `available_years`.
- `hemisphere` (from latitude) and `season_label` on off-season and pre-plant blocks, e.g. "Off-season (May–Oct)". Old field names stay.
- Any crop id from the location's catalog (B2's `catalog_for_location`, stubbed until it lands). The cover-termination sweep works for any cover crop, and rye-specific rules apply only where the catalog has them.

Accept:
- A Pergamino plan runs end to end: soybean planted 11-15, previous harvest 04-20, a cover crop seeded 05-01 and terminated 10-20. It returns an off-season window crossing June, its own dry cutoff, an R95p heavy-rain value and `hemisphere: south`.
- A cell with < 15 years in an era gives `insufficient_data` for that era.
- NC compare, replay, sensitivity and years examples are unchanged apart from the added fields.
- No NC rule appears in a Pergamino result.

## A3 — Farm and field batch API (A, wave 3)

Build:
- `acre/farms/` and `POST /v1/farms/analyze` (contract §5). It takes a farm with fields (GeoJSON geometry, name, plan). It computes geodesic area and centroid server-side (and rejects self-intersecting geometry with `invalid_input`), and groups fields by weather cell.
- Each field gets its own compare result, with capabilities from B1. If its weather is still being prepared, it gets `job_status: pending`.
- `weather_cells[]` with `field_ids` and the fixed note that these fields share one weather series. Only area is totalled.
- `location` is accepted by the existing sensitivity, years and replay endpoints, so the frontend can call them per field.
- Geometry is never logged or echoed. Responses return `field_id`, area and centroid rounded to 2 decimals.

Accept:
- 3 fields in 2 cells give 2 `weather_cells` groups.
- Area is within 0.5% of the turf value for the contract fixture polygons.
- A self-intersecting polygon gives a typed 400 naming the field.
- A farm with an NC field and a Pergamino field gives two independent results and no cross-field metric.
- The log scrub test shows no coordinates.

## A4 — Contract freeze, deploy, smoke (A, wave 4)

Build:
- Regenerate `backend/docs/api/openapi.json` and examples for every new endpoint: NC demo, Pergamino, pending weather, unavailable, offline.
- Bring `docs/global/contract.md` up to date with what shipped.
- Runbook: the Railway volume for `ACRE_CACHE_DIR`, env vars (`ANTHROPIC_API_KEY`, `ACRE_CORS_ORIGINS`, `ACRE_RESEARCH_MODEL`), and the cost and rate limits.
- `backend/scripts/smoke_global.py` against a running server: search, reverse, capabilities, prepare weather, wait, farm analyze, note, profile.

Accept:
- The contract check passes.
- The smoke script passes against a local server: offline for NC, and with a mocked POWER for Pergamino.
- The full suite passes offline.

## B1 — Geo and capabilities (B, wave 1)

Build:
- `acre/geo/`:
  - `search(q)`: Nominatim, plus coordinate parsing for decimal and DMS input.
  - `reverse(lat, lon)`: country ISO2, admin1 (ISO 3166-2 where known), admin2, display name.
  - `koppen(lat, lon)`: bundled raster under `backend/data/geo/`, with its resolution and source.
  - `hemisphere`, POWER `cell_id`, and a land check (no Köppen class means water).
  - Caching, 1 request per second, a generic User-Agent, and no query text in logs.
- Generalise `field/location.resolve` worldwide. `unsupported_location` remains only for water and invalid coordinates. NC region detection (Piedmont, Coastal Plain, ...) is kept.
- `region_key` chain for catalog lookup: `country-admin1` (e.g. `AR-B`), then `country`, then `koppen:<class>`.
- `GET /v1/geo/search`, `GET /v1/geo/reverse` and `GET /v1/locations/capabilities` (contract §3–4). `capabilities_for(lat, lon)` is a library call for A3.
- Offline: geocoder fixtures for the 8 NC points and Pergamino. Live Nominatim is mocked in tests.

Accept:
- `"35.1, -80.5"` and `35°06'N 80°30'W` parse to the same point.
- Pergamino reverse gives AR / AR-B / Köppen `Cfa` / south.
- A mid-ocean point gives `unsupported_location`.
- Capabilities for Union NC: weather `complete`, catalog `verified_source`, soil `usda_sda`, live `nws`, drought `usdm`.
- Capabilities for Pergamino: weather from A1 (stub until merged), catalog `ai_suggested` or `dataset_estimate`, soil `soilgrids`, live `open_meteo`, drought `unavailable`.

## B2 — Regional catalogs and SAGE calendars (B, wave 2)

Build:
- Catalog v3 is a superset of v2. It adds the columns `region_key, country, admin1, koppen, origin, evidence_quote, limitations, conflicts_with`. Loading v1 or v2 maps to `origin: verified_source, region_key: US-NC`, leaving the v1 and v2 files untouched.
- Profiles in `backend/data/catalogs/regions/<region_key>/` (`profile.json` + `crop_rules.csv`): crops, crop calendars, cover crops, common rotations and double-crop options, each with `origin` and sources.
- Generalised crop list (FAO-style ids: maize, soybean, wheat, rice, sorghum, ...), with aliases for the old ids (`field_corn` → maize). Old plans still load.
- Bundled SAGE crop calendars give `dataset_estimate` planting and harvest windows per crop for any land cell.
- `catalog_for_location(loc)`:
  - NC → v2 (verified) and nothing else.
  - Elsewhere → the cached region profile, then SAGE.
  - It never returns NC rules outside NC.
- Checker, finder, calendar, backup and note all take a location and use its catalog. Every rule line carries `origin`.
- `GET /v1/regions/{region_key}/profile` (contract §6).

Accept:
- NC outputs are unchanged (v1 regression tests still pass).
- A Pergamino profile built only from SAGE lists soybean and maize windows as `dataset_estimate` with a source.
- An NC rule id never appears outside NC (tested over 3 non-NC points).
- An unknown crop id gives `invalid_input` naming the field.
- The aliases keep the old sample plans valid.

## B3 — AI regional research (B, wave 3)

Build:
- `acre/research/`: a pipeline for a region key. It only ever gets the country, admin1, climate class and crop list, never coordinates or the farm.
  - It calls the Claude API (`ACRE_RESEARCH_MODEL`, default `claude-sonnet-5-5`) with web search and web fetch, under a source policy: government, FAO, universities, extension services, peer-reviewed work.
  - Structured output is catalog v3 rows plus profile entries, each with `source_url`, locator and an `evidence_quote` of at most 30 words.
- Code check:
  - Fetch each `source_url` and look for the quote (normalised text). Found gives `source_checked`, otherwise `ai_suggested`. A dead URL drops the row and logs it.
  - Every number in a row must appear in its quote, or the row is downgraded to `manual_check`.
  - Disagreeing rows are kept with `conflicts_with`, never merged. Missing evidence is listed in `gaps[]`.
- Jobs: `POST /v1/regions/research` and `GET /v1/regions/research/{job_id}` (contract §6). Results are cached per region key, with one job per key at a time and token and time limits.
- No `ANTHROPIC_API_KEY` gives `unavailable` / `research_not_configured` and the SAGE profile is still served.
- Pre-generate and commit profiles for 3 demo regions (`AR-B`, `IN-PB`, `FR-IDF`) when a key is available. Otherwise commit SAGE-only profiles and say so in the log.

Accept, with a recorded, mocked Claude response:
- Rows parse into catalog v3, and a row whose quote isn't on the page is `ai_suggested`.
- A number not in its quote downgrades the row.
- Two conflicting rows both survive with `conflicts_with`.
- The prompt payload contains no coordinates (tested).
- The rule engine evaluates AI rows normally but every line carries `origin`, and AI rows default to `print: false` unless `source_checked`.

## B4 — Global soil, live weather, tools with area (B, wave 4)

Build:
- SoilGrids v2 at the field centroid (clay, sand, silt, SOC, pH, bulk density at 0–5, 5–15 and 15–30 cm), labelled as a 250 m model estimate and cached. Fields in different 250 m cells get separate values. The US uses SDA first, then SoilGrids.
- Open-Meteo current conditions and the 7-day outlook outside the US, labelled as context, not analysis. USDM in the US, otherwise `unavailable`.
- Irrigation and fertilizer tools take an optional `area_ha` (or `field_id` plus the backend area). They return per-area values and field totals. Metric units are the default outside the US. Without an area they return per-area values only.

Accept:
- SoilGrids down gives soil `unavailable` and the analysis is unaffected.
- 120 lb N/ac urea on a 10 ha field gives the per-acre value from Phase 11 times the area, in both unit systems.
- A non-US point never calls NWS or USDM.

## C1 — Map, search and picking a point (C, wave 1)

Build:
- `web/src/map/`: MapLibre GL JS (exact pinned version) with an Esri World Imagery satellite layer and an OSM street layer, a layer switch, attribution always visible, zoom, pan and a scale bar.
- A search box (backend `/v1/geo/search`, with coordinates accepted). Clicking drops a pin, which calls `/v1/geo/reverse` and `/v1/locations/capabilities`.
- A location card: place name, country and region, climate class, weather cell, and the capability statuses.
- Works against `web/src/api/fixtures/` until B1 is pushed.

Accept, in Playwright with mocked routes:
- Search "Pergamino" shows the result and flies there.
- Typing coordinates drops the pin.
- The card shows the capability statuses from the fixture.
- Attribution stays visible.
- The NC demo still opens without the map.

## C2 — Farm and field editor (C, wave 2)

Build:
- Drawing with terra-draw: draw, edit vertices, move, rename, delete and select polygons. A farm can hold many fields and separate parcels (a MultiPolygon per field). Exclusions are holes, drawn inside a field.
- Area in acres and hectares (turf, geodesic). Self-intersections are rejected with a message.
- GeoJSON import and export (a FeatureCollection with `field_id`, `name` and `plan` properties). Bad files are rejected, never half-loaded.
- Storage in `localStorage` key `acre.farms.v1` (schema in `web/src/farm/types.ts`), with migration and a try/catch fallback to memory. A list of saved farms. Nothing is sent to the backend except for analysis.
- Public API for D: `useFarms()`, `useSelectedField()`, `selectField(id)`.

Accept:
- Draw 2 fields, rename one, add a hole, reload: all three changes persist.
- Export then import round-trips the geometry exactly.
- A bowtie polygon is rejected.
- The area of each contract fixture polygon is within 0.1% of the fixture's `area_ha`.

## C3 — 3D field from polygon (C, wave 3)

Build:
- `scene/FarmWorld` builds each field from its polygon: a local east-north projection around the centroid, scaled to the stage, holes cut out, and growth bands kept. It falls back to the old rectangle.
- The 3D view is labelled "Shape from your drawing; an illustration of planned dates".

Accept:
- L-shaped and holed fixtures render, checked with an image snapshot test or geometry vertex counts.
- The NC demo looks the same as before.

## C4 — Map results layer (C, wave 3)

Build:
- Fields coloured by analysis state (ready, pending, unavailable, has flagged checks), with a legend.
- Clicking a field calls `selectField`.
- The weather cell is drawn as a 0.5° × 0.625° rectangle labelled "one NASA weather series", and the fields inside it are listed.

Accept, in Playwright:
- Clicking a field selects it in D's screens.
- 2 fields in one cell show one cell outline and the shared notice.
- A pending field shows its pending state, then updates when the job is ready (mocked).

## D1 — App shell, farm state, adapter (D, wave 1)

Build:
- The entry flow: the landing page or `?view=app` opens the map (C1) with "Open the Union County demo" next to it. The demo still loads from saved data, offline.
- Remove the NC-only place picker from the flow (keep it in the code until D4).
- State: `Farm → Fields → Plan` in `state/`, with the selected field and the location context from it. It uses C's `farm/types.ts`.
- `api/adapt.ts` and `client.ts` cover the new endpoints with zod schemas, plus fixtures in `web/src/api/fixtures/` built from `docs/global/contract.md`. `adapt.ts` stays the only file that knows backend field names.
- Capabilities panel for the selected location.

Accept:
- Unit tests: the adapter parses every contract fixture, and unknown fields are tolerated.
- The demo path is unchanged (existing tests pass).
- Map entry to a picked point shows the capabilities panel from the fixtures.

## D2 — Field-level planning screens (D, wave 2)

Build:
- A plan editor per field:
  - Crops and covers come from the location's profile (`/v1/regions/{key}/profile`). "My crop isn't listed" is a free entry, saved as `grower`.
  - Dates and management are editable and checked by the backend.
- A field switcher that keeps each field's draft.
- The existing pages (Overview, Past springs, Compare, Plan detail, Cover timing (was Rye timing), Calendar, Extension summary) read from the selected field. Calls go through `/v1/farms/analyze` and the per-field `location` params.
- Farm overview: a table of fields (name, area, crops, plan, analysis status, weather cell). Area is the only total.
- Season wording from `season_label` (keep "winter" for NC).

Accept:
- Two fields with different plans show different results, and switching keeps the drafts.
- The overview has no summed metrics.
- A Southern Hemisphere fixture shows "Off-season (May–Oct)" labels.
- Existing view-model tests pass.

## D3 — Provenance, research review, resolution notices (D, wave 3)

Build:
- One badge component for each `origin` value, used on every number and rule line, with the evidence drawer extended.
- Research panel:
  - Shows profile suggestions with their sources, `ai_suggested` versus `source_checked`, conflicts and gaps.
  - "Use as my practice" copies a suggestion into the field plan as `grower`; dismissing hides it.
  - It never shows AI rows as verified.
- Resolution notices: shared weather cell, SoilGrids 250 m, and dataset-estimate calendars.
- Unavailable and partial states per capability. Update the privacy page (where coordinates go).

Accept:
- Every fixture value renders a badge.
- An `ai_suggested` row can't render a "verified" style (tested).
- Accepting a suggestion marks it `grower`.
- The shared-cell notice appears for the 2-fields-1-cell fixture.

## D4 — Integration and release (D, with C, wave 4)

Build:
- Switch to the live backend: merge `origin/backend` and run the backend locally (offline NC, mocked POWER for Pergamino).
- Regenerate the saved data (`npm run data`).
- Full Playwright workflow: search → draw 2 fields → assign plans → analyze → open a field → Cover timing → field note → export GeoJSON → reload.
- Remove the dead NC picker. Build for deploy (hosting decided by Rahul in wave 4: GitHub Pages needs a public repo or GitHub Pro for a private one).

Accept:
- The workflow spec passes against the local backend.
- `npm test`, typecheck and build are clean.
- The demo works offline.
- Lighthouse accessibility is ≥ 90 on the map page.


---

## P1 — Goals, constraints and rotation generator (B, wave 3)

Build:
- `planner/goals.py`, with the goals and constraints model (contract §8):
  - Priorities from a fixed list (`soil_cover`, `water_conservation`, `weather_resilience`, `crop_diversity`, `living_cover_duration`, `management_simplicity`), each with a weight of 0–3. 0 means "don't care". Weights are relative and never shown as a score.
  - Hard constraints:
    - allowed and excluded crops;
    - must-include crop;
    - irrigation available yes/no/unknown;
    - equipment limits (no_drill_interseeding, no_roller_crimper, ...);
    - latest planting and earliest harvest dates;
    - number of seasons (1–4);
    - crop history: the last 1–3 crops on the field.
  - Preferences (soft): crops liked or disliked.
  - Unknown stays unknown and never counts as "no".
- `planner/generator.py`: `generate_candidates(location, field_context, goals)` enumerates multi-season sequences, including cover-crop and double-crop combinations.
  - Inputs: the location's catalog (`catalog_for_location`), the regional crop calendars (SAGE and profile windows), the rotation-compatibility and planting-window rules, crop history, and the hard constraints.
  - Dates: each sequence gets dated windows from sourced calendars (with `origin` on each date). Hard constraints prune candidates; a candidate that breaks one is never returned.
  - Rule checks: every candidate goes through the existing checker. A candidate with an `avoid` or blocking verdict is dropped. One with `manual_check` stays, flagged.
  - Limits: capped at 50 candidates per field, deterministic order, and a `generation_log` of what was pruned and why.
  - Thin evidence: if the catalog has fewer than 2 crops with sourced calendars for the location, return `status: insufficient_data` with `gaps[]` and no candidates.
- `POST /v1/plans/generate` (contract §8). Generated plans are ordinary `Plan` objects, so a farmer can edit any of them and send it to compare, check or the future plan.

Accept:
- Union County with defaults generates the 3 existing presets among its candidates.
- Excluding soybean removes every sequence containing it.
- A latest-planting date prunes late double-crops, and the pruning is logged.
- Crop history `soybean, soybean` with a sourced rotation rule against a third soybean drops that sequence.
- A location with no sourced calendars gives `insufficient_data`.
- Pergamino generates Southern Hemisphere-dated sequences, and no NC rule ids appear.
- The output is identical across runs.

## P2 — Indicators and Pareto evaluation (A, wave 3)

Build:
- `compare/indicators.py`: a per-candidate indicator vector. Each indicator has `{value, unit, direction: higher_better|lower_better, origin, definition, source}`. Most reuse the existing analysis:
  - `rain_on_bare_soil_mm` (median off-season rain outside living cover) and `heavy_rain_days_on_bare_soil`;
  - `dry_pre_plant_frequency` (share of the cell's seasons that were dry for each planting window; per-window denominators kept);
  - `modeled_root_zone_wetness_at_planting` (labelled modeled);
  - `living_cover_days` and `bare_soil_days` per year;
  - `crop_family_diversity` (distinct families over the sequence; families from the catalog);
  - `rule_flags` (count of flagged and `manual_check` checks, listed);
  - `management_operations` (count of distinct field operations: seed, terminate, plant, harvest, per season);
  - `irrigation_dependence` (only when irrigation access is known).
  - The soil-health and water linkage is qualitative and sourced, for example the USDA NRCS soil health principles (keep the soil covered, maximise living roots, increase diversity) and water-conservation guidance. Each indicator's `rationale` cites a source. The definitions, relationships and sources go in `backend/docs/indicators.md` before coding.
  - Soil context (texture, SOC, drainage from SDA or SoilGrids) is attached as `context` and is never turned into a benefit number.
- `compare/pareto.py`:
  - Map the farmer's non-zero priorities to their indicators (the mapping table is in `docs/indicators.md`).
  - Compute the non-dominated set over those indicators, comparing only candidates whose indicators are all available and that share a location and catalog. Missing indicators make a candidate `partial` and keep it out of dominance comparisons against complete ones; it gets listed separately.
  - Order the shortlist by the weighted sum of **rank positions** (no raw-value arithmetic across units). Show the ordering method in the response.
  - Report the trade-off pairs: which indicators each shortlisted plan wins and loses against the others.
- Explanation per shortlisted plan:
  - `why` (the indicators where it is best, with values and sources);
  - `trade_offs`;
  - `uncertainties` (modeled data, `ai_suggested` rules, `dataset_estimate` calendars, short coverage);
  - `historical_vulnerabilities` (its worst 3 past seasons by its weakest indicator, with year links to the replay).
  - The response says the shortlist is "not universally optimal; depends on these priorities and this history".
- `POST /v1/plans/recommend` (contract §9): goals + field context → P1 candidates → indicators → shortlist and explanations. It also accepts a farmer-edited candidate list instead of generating one.

Accept:
- Dominance is tested on synthetic vectors: ties, a missing indicator, and a single candidate.
- Union County, with `soil_cover` weighted 3, shortlists the rye plan and explains its bare-soil rain advantage and its dry-spring check trade-off, with the real numbers from compare.
- Changing the weights reorders the shortlist without changing any indicator value.
- No field in the response is a composite score.
- Pergamino runs with its own thresholds.
- Indicator definitions are in `docs/indicators.md`, each with a source.

## P3 — Future multi-season farm plan (B, wave 4)

Build:
- Extend `planner/calendar.py` and `planner/backup.py` into `planner/future.py`, which takes a chosen plan (generated or edited), a start season and N seasons. It returns dated windows for each season (the actual future dates from the plan's MM-DD values plus the calendar), each with `origin` (`verified_source`, `dataset_estimate`, `grower` or `assumed`).
- Each season contains:
  - planting and harvest windows;
  - the cover-crop schedule;
  - management milestones;
  - decision deadlines, using the existing switch-condition logic and `next_check_date`;
  - source-backed explanations;
  - warnings (rule flags);
  - historical vulnerabilities (from P2);
  - the backup strategy (the existing backup plan, per season).
- Editing: an `edits[]` input (move a date, swap a cover, change a priority) returns the updated plan plus a diff that reuses the existing calendar diff. The analysis reruns through P2 for the changed plan only.
- `POST /v1/plans/future` (contract §10). The field note (Phase 9) gains a `future_plan` section.

Accept:
- The Union rye plan over 2 seasons gives real 2027 and 2028 dates, and every date's `origin` is right.
- Moving rye termination by 7 days updates the milestones and decision deadline, and the diff lists the changes.
- A Pergamino plan gives southern dates crossing the calendar year.
- The note includes the future plan with audit ids.

## P4 — Goals and constraints UI (Abhi, wave 3)

Per field:
- Priority sliders (0–3) for the P1 list. The old priority picker becomes this.
- Hard constraints and preferences, kept clearly apart.
- Crop history entry.
- Unknown stays a real answer.
- Stored with the field in `acre.farms.v1`.

Accept: values round-trip through storage and the contract §8 request fixture, and unknown never serialises as false.

## P5 — Options and recommendation screens (Abhi, wave 4)

Build:
- "Find plans for this field" calls `/v1/plans/recommend` and shows the shortlist. Each plan gets its why, trade-offs, uncertainties and historical vulnerabilities, with origin badges and links to replay years.
- A trade-off view over the farmer's chosen indicators: a small multiples table or chart, no composite score.
- "Edit this plan" opens it in the field plan editor. `insufficient_data` shows the gaps and offers manual planning.

Accept:
- The Union fixture shows the rye plan's explanation.
- No score appears anywhere (tested).
- A weight change reorders without changing values.
- `insufficient_data` renders the gaps.

## P6 — Future plan editor (Abhi, wave 5)

Build:
- The selected plan becomes a multi-season timeline: windows, cover schedule, milestones, deadlines and the backup, from `/v1/plans/future`.
- Dates are draggable, sending `edits[]` and showing the returned diff and updated analysis.
- Sourced dates, assumptions and grower-entered dates are visibly different.
- Print or export with the field note.

Accept: a drag updates the deadline and the diff (mocked), origin styles are tested, and the export includes the future plan.
