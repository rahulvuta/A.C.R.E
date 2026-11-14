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
