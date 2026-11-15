# Scenario views for Frontend D

Import components and types from `src/sim/index.ts`. Components import their scoped CSS and Hanken Grotesk; they need no chart library. They render props without fetching or storing farm data.

- `ScenarioResults({ scenario: Scenario })` shows annual margin and bare-soil rain bands, total margin, living cover, event odds, money gaps, and separate farmer-reading dots and NASA wetness lines. Each chart has a disclosure with exact values and origins.
- `ScenarioCompare({ result: SimulationResult, baselineId: string, onChoose: (scenarioId: string) => void })` shows up to six plan columns. The callback returns the chosen scenario ID. Pass the ID of the current plan as `baselineId`; deltas are matched by both scenario and baseline. Badge reasons, trade-offs, and undecided reasons come from the response. The comparison caveat stays above the columns while scrolling.
- `BadgeRow({ badges: ScenarioBadge[], scenarioId?: string, scenarioLabels?: Record<string, string>, notDecided?: Reason[] })` displays supplied badges and explanations. Pass `scenarioId` to show only that plan's badges.
- `DeltaList({ deltas: ScenarioDelta[], scenarioId: string, baselineId: string, baselineLabel?: string })` displays supplied differences. It never subtracts, ranks, or totals results in the browser.

`simulateScenarios(request: SimulateRequestInput, signal?: AbortSignal)` validates the request and response with Zod and posts to `/v1/scenarios/simulate`. The base is `import.meta.env.VITE_API_BASE ?? "http://localhost:8000"`. Failures throw `SimulationApiError`; request validation throws Zod's error. Aborts pass through. There is no automatic fallback to example data. The rotation uses the existing `planning/api.ts` Plan schema.

`simulationResultSchema` and `scenarioSchema` are exported for parsing existing records before passing them to components. The common contract requires provenance, but its sample omits it on some totals, events, and comparisons. These schemas accept those omissions and scalar totals. The UI labels missing provenance `Origin not available`, without assigning a source. A numeric zero stays visible; null and omitted values show `Not available`.

Money and weather stay separate unless the response names `includes_assumption`. Farmer moisture percentages and NASA's surface-wetness index use separate plots and units. The browser only formats returned results and maps values to chart coordinates. It does not calculate money, agronomy, odds, badges, or scores.

From `web/`, run `npm run dev` and open `/src/sim/harness.html`. It uses the clearly labelled synthetic fixtures in `fixtures.ts`, with a comparison view, a result view, a missing-money switch, and a choice callback preview. It makes no API requests. The example dollar values are invented UI fixtures, not published references or results from the simulation engine.

Run `npm test -- src/sim` for local checks, then `npm test` and `npm run typecheck` before integration. The harness is a Vite development page; production routing belongs to the integrating screen.
