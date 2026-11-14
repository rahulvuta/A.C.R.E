# A.C.R.E Scenario Simulator: plan (2026-11-14)

**What the farmer gets.** First, A.C.R.E simulates **what I do now** over the next 10 years. Then it tries alternative plans, runs them side by side, and shows which one is best for profit, for the soil, for lowest weather risk, and for *my* priorities. Each result says why. The whole app tracks acres, crop prices, costs, equipment and the farmer's own field readings. A guided flow makes it usable on first visit, and a **Demo mode** fills everything in.

This file extends `plan.md` (the earlier cards are all done). The shapes are in `contract.md` §11–§16. The rules are in the root `CLAUDE.md`. §3 of that file is updated by this plan.

## How the simulator stays honest (science rules for S-cards)

1. **Weather futures come from history.** A 10-year run draws whole past seasons (1981–2025) from the field's own NASA POWER cell, at random with a fixed seed, about 200 runs. Results show the median and a p10–p90 band, plus the odds of events, such as "3 or more dry springs in 10 years: 34% of runs". The label is always *"replays real past weather in new orders; not a forecast"*.
2. **Money comes from the farmer's numbers.** Each crop's yield, price and costs are, in priority order:
   - **the farmer's own value** (`grower`);
   - a **sourced regional reference** (`verified_source` or `dataset_estimate`: USDA NASS prices and yields, USDA ERS costs and returns, university custom-rate surveys, FAOSTAT producer prices and yields);
   - otherwise **blank**, so that crop has no money result.

   Prices run in low, typical and high cases built from the source's historical range.
3. **Weather and money connect only through the farmer's assumption.** The farmer can set "In a dry spring I lose about __% of yield" (and the same for wet or heavy-rain years). That turns a weather event into money, and the result is labelled `assumed (your estimate)`. Without it, money results and weather risk appear **side by side and are never combined**. There is no yield model and no invented loss figure.
4. **What "best" means.** Each scenario gets badges:
   - **Best for profit:** highest median 10-year margin. Shown only when every compared scenario has money inputs.
   - **Most sustainable:** Pareto-best on the soil and water indicators (living cover, rain on bare soil, crop diversity).
   - **Lowest weather risk:** fewest stress events.
   - **Best for your priorities:** the existing weighted-rank method over all of the above.

   A scenario can win several badges. The UI always says "best of the scenarios you compared, given these numbers and past weather".
5. Everything else stands: blank is never 0, the 9 status words, `origin` on every value, AI is never verified, NC rules apply only in NC, and coordinates are never sent to the AI.

## Cards and owners

| Card | Owner | Builds | Depends on |
|---|---|---|---|
| **S1** Scenario engine | Agent A (Claude) | `backend/acre/simulate/`: 10-year sequences from a rotation (cycled), historical-resampling runs, per-year indicators (reusing P2), distributions and event odds. `POST /v1/scenarios/simulate` (§11) | — |
| **S2** Compare and badges | Agent A | Scenario comparison against the baseline ("current plan"), the 4 badges, plain-language reasons, deltas against the baseline. Same endpoint (§11). Joins in S3's money results | S1, S3 |
| **S3** Economics | Agent B (Claude) | `backend/acre/economics/`: per-crop yield, price and costs for the location (resolution order above), equipment pass costs, area totals, low/typical/high price cases, the farmer's loss assumptions. `POST /v1/economics/estimate` (§12) plus the library call S2 uses | E0 data |
| **E0** Economics reference data | Codex (worktree) | `backend/data/economics/`: CSVs with sources. US: NASS 5-year price and state/county yield for the major crops, ERS cost-and-return per acre (corn, soybean, wheat, cotton, sorghum, rice, peanuts), a custom-rate table for common passes (a university survey). Global: FAOSTAT producer price (USD/t) and yield (t/ha) by country for the top 25 crops. Every row has source, URL, year and units. No invented rows; gaps are left blank | — |
| **S4** Crop library and research | Agent B | `backend/acre/croplib/`: a central crop library in SQLite (a file, not a server) seeded from catalogs, SAGE and E0. `GET /v1/crops/search` lists known crops plus a "research this crop" option. `POST /v1/crops/research` researches an unknown crop through the OpenRouter guardrails (B3) and caches it centrally for all users, marked `ai_suggested` or `source_checked` (§13) | S3 for the money fields |
| **S5** Field context: equipment and readings | Agent B | Equipment list (from a fixed vocabulary, plus "other"), used by the generator's feasibility check and by economics pass costs. Farmer readings (soil moisture, rainfall, notes; dated; `origin: grower`) accepted in field context and returned beside modeled values in simulate and replay, never mixed into NASA numbers (§14) | — |
| **S6** Demo and autofill | Agent A | `GET /v1/demo/farm?scenario=union|pergamino`: a complete demo farm (2–3 fields, current plans, prices, equipment, sample readings). `POST /v1/plans/autofill` gives typical dates for chosen crops at a location from catalogs and SAGE, each with its `origin` (§15) | S4 |
| **U1** Guided flow and integration | Frontend D (Claude) | New information architecture and guided flow (below), state, adapter for §11–§16, Demo mode, merging U2–U4, final e2e | contract |
| **U2** Simulation and comparison views | Codex (worktree `fe-u2`) | `web/src/sim/`: 10-year fan charts, side-by-side scenario columns, badge row, "why this wins", deltas against the current plan, event odds | contract fixtures |
| **U3** Inputs | Codex (worktree `fe-u3`) | `web/src/inputs/`: crop picker (search, "type your own" → research with progress), dates with a "fill typical dates" button, prices/yields/costs editor showing the defaults and their sources, equipment editor, readings log (add a reading any time, list and chart) | contract fixtures |
| **U4** Farm and 10-year timeline | Frontend C (Claude) | Acres front and centre (per field and farm total), field cards, a 10-year plan timeline (`web/src/timeline/`), the demo farm drawn on the map | contract fixtures |

## The guided flow (U1): professional, explained, not minimal

The sidebar shows the steps with progress. Each step has one clear question, a short plain sentence, and a "What does this mean?" link.

1. **Your farm:** find it, draw your fields, and see the acres right away. Or **Try a demo farm** (Union County NC, or Pergamino AR).
2. **What you do now:** for each field: crops (search or type your own), "Fill typical dates" (autofill), equipment, and (optional) your prices, yields and costs, which defaults fill from sources.
3. **Simulate your current plan:** 10 years over about 200 replays of real past weather, giving money, soil and water results, and weather risk.
4. **Try other plans:** suggested scenarios (the generator plus recommend), or build your own. Up to 5 alongside your current plan.
5. **Compare:** side-by-side columns with badges (best for profit, most sustainable, lowest risk, best for your priorities), each with its reasons and its trade-offs.
6. **Your 10-year plan:** the chosen scenario as a dated timeline with actions, deadlines and a backup. Log a reading at any time. Print or export.

## Order and timing

- **Wave S-a** (parallel, now): S1, S3, E0, S4 (seeded from catalogs while E0 runs), S5, U2, U3, U4, plus U1's shell and Demo mode against fixtures.
- **Wave S-b:** S2 (S1 + S3), S6 (S4), U1 integration (merge U2–U4), e2e against the live backend.
- **Reviews:** one Codex review per agent at the end (high effort for S1–S3), with one fix pass.
