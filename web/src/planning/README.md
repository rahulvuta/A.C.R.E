Planning screens for contract §§8–10. Import from `web/src/planning/index.ts`; each component loads its own scoped styles. The host should load the existing theme tokens and base stylesheet.

- `GoalsPanel({ value, onChange })` edits `GoalsPanelValue = { goals, crop_history }`. `createGoalsPanelValue()` supplies a fresh initial value. The component reports crop edits as they are typed and never reads or writes storage. D owns saving these values with the field in `acre.farms.v1`.
- `Recommendations({ location, field?, goals?, candidates?, onEditPlan, onUsePlan, onPlanManually?, onReplay? })` requests the shortlist whenever its request changes. Both plan callbacks receive a `RecommendationCandidate`. `onReplay` receives the exact ready POST request; without it, an inline historical replay opens. Values, units and per-indicator ranks come from the service.
- `FuturePlan({ location, candidate?, plan?, plans?, startSeason?, seasons?, priorities?, onChange?, onReplay? })` accepts exactly one plan source. Pass a `GeneratedCandidate` from `generatePlans()` to preserve individual date origins. A manually entered `plan` or `plans` list is treated as grower input by the backend. Date changes send cumulative, season-specific `edits[]`; `onChange` receives the latest `FutureResponse`, including updated season plans and the returned diff. Printing includes folded details.
- `PlanningFlow({ location, field, onReplay? })` is the in-memory demo: goals → shortlist → future plan, with a blank manual editor when evidence is insufficient. It resolves the chosen recommendation against `/generate` before `/future`, because `/recommend` does not return individual date origins. It refuses an unmatched plan rather than assigning new origins.

D can mount the complete demo with a field context, without passing its geometry:

```tsx
import { PlanningFlow } from "./planning";

<PlanningFlow
  location={fieldCentroid}
  field={{
    field_id: field.field_id,
    area_ha: field.display_area_ha ?? null,
    crop_history: savedPlanning.crop_history,
    soil: null,
  }}
/>
```

For the persisted workflow, mount the three components separately. Keep `GoalsPanelValue` in the host's field state, pass `value.goals` to `Recommendations`, route `onEditPlan` to the field editor, and use `generatePlans({ location, field, goals })` to recover the matching candidate for `FuturePlan`. The existing farm `Field` model does not yet include goals or crop history; D needs to extend that model and its storage adapter. No files outside this module were changed for that integration.

From `web/`, run `npm run dev -- --port 5175` and open `http://localhost:5175/src/planning/harness.html`. The harness uses the Union County demonstration point (34.98, -80.55). Requests use `import.meta.env.VITE_API_BASE ?? "http://localhost:8000"`. The backend's default CORS list omits port 5175: include `http://localhost:5175` in `ACRE_CORS_ORIGINS` before starting the backend, retaining other frontend origins you use.

Run `npm test`, `npm run typecheck`, and `npx playwright test -c src/planning/playwright.config.ts`. The dedicated Playwright configuration serves the development harness at port 5175; these specs skip under the production-preview configuration. API tests include real backend Union County responses, narrowed to one candidate per response list; component and browser fixtures are explicitly synthetic. The real generation and future fixtures were obtained in-process with the backend's FastAPI test client in offline mode.

Validation in this sandbox: all 21 planning tests and TypeScript pass. The full suite reports 302 passes and one existing failure at `src/farm/farm.test.ts:26`: `pergamino_square` differs from its fixture area by 0.220%, above the test's 0.1% tolerance. Running that farm test alone reproduces it without loading the planning module. It was left unchanged under the file restrictions. Playwright cannot start its Vite server because the sandbox denies listening on port 5175 (`EPERM`); browser visual review was also blocked by the available browser's URL policy.
