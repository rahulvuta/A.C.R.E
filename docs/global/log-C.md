# Agent C log

Status lines (`YYYY-MM-DD <card>: done | what is left`) and handoffs (`C→X: ...`). Only Agent C edits this file.


## 2026-11-14 (Frontend C session, branch `fe-c`)

- 2026-11-14 C1 fixes: done | tools group says "partial" only when at least one tool is usable (mixed unusable → the least hopeful word); gated-search e2e now really gated; new e2e for a pick before the map loads (`map-load.spec.ts`) and a world-copy click (lon stays in ±180). `map.config.ts` webServer now starts Vite from `web/`.
- 2026-11-14 C2: done | area uses the contract radius 6378137 m (turf 7 uses 6371008.8 m, 0.22% low); e2e `farm-editor.spec.ts`: draw 2, rename, hole, reload persists; export→import exact; bowtie rejected; bad file rejected whole. Left: nothing known.
- 2026-11-14 C3: done | `FarmWorld` takes `outlines` (one per strip, same order); polygon fields are cut to the drawn shape (holes, parcels), plants and straw only inside. Water line and roots on the cut face are drawn only for the square fallback. NC demo unchanged (no `outlines` passed). Unit test: `scene/polygonShape.test.ts`. Dev page: `/src/scene/harness.html?shapes=1`.
- 2026-11-14 C4: done | field colours by state with a legend, click a field → `selectField`, weather cell outlines from the backend's `cell.center` + `size_deg` labelled "one NASA weather series", with the fields in each cell and the shared notice when ≥ 2. e2e `farm-results.spec.ts`.

### For D: what to mount (`import … from "web/src/map"`, i.e. `src/map/index.ts`)

- `<FarmMap api={createFetchGeoApi(VITE_API_BASE)} … />`: search, pin, location card, the farm editor and the results layer in one. Props:
  - `api: GeoApi` (required): `createFetchGeoApi(base)`.
  - `fieldStates?: Record<field_id, "none" | "ready" | "pending" | "unavailable" | "flagged">`: map the farm analysis per field: `job_status: pending` → `pending`; result `status` complete/partial with a flagged check → `flagged`, otherwise `ready`; unavailable/unsupported/failed → `unavailable`; not analysed → leave out (`none`).
  - `weatherCells?: { cellId, center: {latitude, longitude}, sizeDeg: [lat, lon], fieldIds, note? }[]`: straight from `weather_cells[]` (`cell.center`, `cell.size_deg`, `field_ids`, `note`).
  - `children?`: extra panel content under the key (e.g. "Open results").
  - `pickAction?(pick)`: replaces "Start a farm here" under the location card.
  - `onMapReady?(map)`.
- `MapScreen` (search + pin only) and `MapView` (bare map) are also exported if D wants less.
- Hooks: `useFarms()` → `{ farms, farm, selectedFarm, selectedFieldId, persistence, notice, actions }`; `useSelectedField()` → `Field | null`; `selectField(id | null)`; also `farmActions`, `updateFieldPlan(fieldId, plan)`, `putFarm(farm)`. Store is `localStorage` `acre.farms.v1`, memory fallback with a notice.
- 3D: `<FarmWorld … outlines={strips.map(s => fieldFor(s)?.geometry)} />` and show `SCENE_SHAPE_LABEL` from `scene/polygonShape.ts` ("Shape from your drawing; an illustration of planned dates") next to the view when outlines are given.
- C→D: `state/farmSource.ts` can now re-export from `farm/hooks.ts`.

## 2026-11-14 U4 (Scenario Simulator: farm, acres, 10-year timeline)

- 2026-11-14 U4: done | acres on field cards and map labels, live farm total while drawing, demo farm loader, `web/src/timeline/` (TenYearTimeline, TimelineCompare, MiniTimeline) with §11/§15 example fixtures. Left: switch the demo to the live `GET /v1/demo/farm` once A ships it (already tried first; falls back to the example file); Pergamino demo has no example file yet (backend only).

### For D (U1): what to mount

- **Timeline** (`import … from "web/src/timeline"`):
  - `<TenYearTimeline scenario={…} riskAt?={0.3} note?={method.note} compact?={false} />`: one row per year, Jan–Dec, bands for cash crop / cover / bare ground, planting and harvest marks, an amber dot when that year's `dry_pre_plant` or `heavy_rain_at_planting` probability ≥ `riskAt`, and a hover/focus card with margin median, p10–p90, odds, rain on bare soil and living cover days. Header shows `totals.margin_10y`. Missing money says "Not available".
  - `<TimelineCompare scenarios={[…]} riskAt? note? />`: 2–6 scenarios as lanes on one 10-year axis; the baseline gets "Your current plan"; hover a year for the same card.
  - `scenario` is a §11 `scenarios[]` item plus `rotation` (the request's rotation plans) and `is_baseline`. Build it with `withRotations(response, request)`. Without `rotation` the timeline still shows the crops in order, without dates, and says so.
  - `<MiniTimeline plan={FieldPlan} year? />` and `planCrops(plan)` for compact field cards.
  - Example fixtures (labelled): `timeline/fixtures/simulate-union.json` (§11 response, 3 scenarios), `simulate-union.request.json`, `demo-farm-union.json` (§15). Dev page: `/src/timeline/harness.html`.
- **Map** (`<FarmMap>` unchanged props): field cards now show acres (bold) and hectares, crops, plan status (from `fieldStates`), and a mini timeline. A "Farm total" (area only) updates live while drawing or editing; the drawing hint shows the shape's acres. Each field is labelled on the map with name and acres (hidden below zoom 12). "Try a demo farm (Union County, NC)" in the empty panel loads the demo and zooms to it.
- **Demo**: `loadDemoFarm("union", api.demoFarm)` → `{ok, demo: {farm, label, source: "backend"|"example", goals, economicsOverrides}}`; then `putFarm(demo.farm)`. `GeoApi.demoFarm?` is new (optional).
- **Types**: `Field` gained optional `equipment?: string[]` and `readings?: FieldReading[]` (§14); the store keeps them across reloads; `farmActions.updateField(id, {equipment, readings})` works.

- 2026-11-15 (Abhi): my own C1 and C2 fixes from 11-14 (unpushed) covered the same findings as the fe-c session. In the merge with main I kept fe-c's code, tests and fixture areas and dropped mine.

