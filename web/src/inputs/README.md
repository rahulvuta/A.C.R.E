# Farmer inputs

Import components and types from `src/inputs/index.ts`. Styles and the bundled Hanken Grotesk font load with the components. All saved form values belong to the parent: pass `value` and replace it with the argument from `onChange`. These components do not use browser storage. Search text, unfinished date text, reading drafts and request state are temporary component state.

The live client uses `import.meta.env.VITE_API_BASE ?? "http://localhost:8000"`. Failed requests leave farmer inputs editable and show an error with retry. Live requests never fall back to example data.

Exports for Frontend D:

- `CropPicker`: `{regionKey: string, value: Crop | null, onChange, api?, label?}`. Selection returns the full crop record, including its origin and sources. Research sends only the crop name and region; polling stops on unmount or a changed query or region. AI results remain labelled AI-suggested, including results with `source_checked` provenance.
- `PlanEditor`: `{location: InputLocation, value: PlanEditorValue, onChange, regionKey?, api?}`. `PlanEditorValue` is `{plan: PlanDraft, dates: DateEvidence[], cropDetails: Crop[]}`. `plan` uses the contract's `previous_crop_id`, `prev_harvest`, `winter`, `next_crop_id`, `next_plant` and `plan_id` fields; `dates` keeps provenance and sources separately. Supply crop details when loading an existing plan. `regionKey` defaults to `value.plan.region`; pass it explicitly when the location is just coordinates or a cell. `createPlanEditorValue(planId?)` returns a blank draft. Drafts can contain null required fields; validate before submitting for simulation. Changing a crop clears its associated dates. Autofill preserves grower dates, including grower blanks and edits made during a request.
- `EconomicsEditor`: `{location: InputLocation, crops: string[], area: {value: number | null, unit: "acre" | "ha"}, value: EconomicsValue, onChange, api?}`. `createEconomicsValue()` returns a blank value. The editor fetches reference defaults without overrides, so reset can restore them. Controlled values contain only `overrides` and `loss_assumptions`. Per crop, overrides contain `price?: {low?: Quantity, typical?: Quantity, high?: Quantity}`, `yield?: Quantity`, and `costs?: Record<item, Quantity>`. A `Quantity` is `{value: number | null, unit: string, origin, source?}`. Overrides always become `grower`; loss percentages remain numeric or null and display `assumed (your estimate)`. Units can be edited, including when no reference exists. No totals, yields, prices or weather losses are calculated here.
- `EquipmentEditor`: `{value: string[], onChange, api?}`. Known IDs come from the API; other entries use `other:<text>`. Unchecked means unselected, not confirmed unavailable.
- `ReadingsLog`: `{value: Reading[], onChange}`. A reading is `{date: "YYYY-MM-DD", kind: "soil_moisture_pct" | "rainfall_mm" | "soil_temp_c" | "note", value: number | null, origin: "grower", note?}`. Note-only entries use null. Unknown numeric entries are not saved as zero. The SVG chart shows one measurement unit at a time, with every entry also available in the text list. Reload persistence is the parent's decision.
- `AreaSummary`: `{areaHa: number | null | undefined}`. Displays hectares and the equivalent acres; this unit conversion is for display only. Missing, nonfinite or negative area shows “Not available”; actual zero remains zero.

`createInputsApi(base?)`, `InputsApi`, `InputsApiError`, response schemas and data types are exported. The draft equipment endpoint has no envelope in §14; this client expects `{meta, equipment: [{id, label}]}`. Adapt `api.ts` when the backend publishes its final shape. The draft economics contract shows scalar `overrides.<crop>.price` for simulation, but does not define low/high overrides. The editor retains each price case separately so D can map them to the finalized simulator contract without discarding farmer input. Do not send this UI override model unadapted to a scalar-price endpoint.

To view the standalone page, run `npm run dev` from `web/`, then open `/src/inputs/harness.html`. It starts in labelled example mode with synthetic values and no API calls. Search for `okra` to exercise research progress and selection. The live-service switch retains the visible example form inputs, and the banner continues to identify them as examples. Example values reset on reload.

Checks from `web/`:

```sh
npm test -- src/inputs
npm run typecheck
npx playwright test -c src/inputs/playwright.config.ts
```

2026-11-14 U3: components, typed clients, explicit example fixtures, standalone page and tests are implemented. Live integration depends on the draft endpoints shipping; no commit or push was made.
