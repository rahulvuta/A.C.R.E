# Handoff to Codex: finish the A.C.R.E Scenario Simulator

You are the new lead engineer and coordinator for **A.C.R.E**, taking over from a Claude coordinator and its Claude and Codex workers mid-build. Spawn your own parallel sub-agents, one per track below, each in its own git worktree and branch, so they never edit the same files. Then integrate, verify and merge. Finish everything.

## 1. Project in one paragraph

A.C.R.E is a NASA Space Apps farm planning tool and **scenario simulator**:
1. A farmer finds their farm on a map and draws fields (the acres are measured).
2. They enter what they grow now (any crop; unknown crops are AI-researched once and cached centrally), their equipment, prices, yields and costs (or sourced defaults), and their own field readings.
3. A.C.R.E simulates their current plan 10 years ahead by **replaying real past NASA weather (1981–2025) in random orders** (not a forecast).
4. It tries alternative plans and compares them side by side, with badges: best for profit, most sustainable, lowest weather risk, best for your priorities.
5. It turns the chosen plan into a 10-year action timeline.

There is a Demo mode that fills everything in.

## 2. Read first, in this order

1. `CLAUDE.md` (root): git, ownership and **science rules §3**. These are binding.
2. `docs/global/simulator.md`: the S-cards, the guided flow and the honesty rules.
3. `docs/global/contract.md` §11–§16: the API shapes.
4. `docs/global/log-A.md`, `log-B.md`, `log-C.md`, `log-D.md`: each has a **"HANDOFF" section** at the end with the exact state and next steps per card.
5. `backend/CLAUDE.md` §3 and `web/CLAUDE.md` + `web/docs/theme-kit.md`: engineering and UI rules.

## 3. Repo, branches, folders (local machine)

- Remote: https://github.com/rahulvuta/A.C.R.E (private). Push only there.
- `main`: releases. You (the lead) merge into it after verifying.

| Folder | Branch | Content |
|---|---|---|
| `/Users/rahulvuta/Desktop/Projects/NSA26` | `backend` | backend (Python package `acre`) |
| `/Users/rahulvuta/Desktop/Projects/NSA26-main` | `main` | merge point |
| `/Users/rahulvuta/Desktop/Projects/NSA26-frontend` | `frontend/dev` | frontend integration |
| `/Users/rahulvuta/Desktop/Projects/FE-c` | `fe-c` | U4: acres, demo farm on the map, 10-year timeline. **Done**, `68371aa` |
| `/Users/rahulvuta/Desktop/Projects/FE-d` | `fe-d` | U1: guided flow, Demo mode, integration. **WIP**, `f19b9b7`; U2 and U4 already merged and mounted; 5 failing tests in `guided.test.tsx`; U3 not merged; e2e not written |
| `/Users/rahulvuta/Desktop/Projects/FE-p` | `fe-u2` | U2: simulation and comparison views. **Done**, `1f504a1` |
| `/Users/rahulvuta/Desktop/Projects/FE-s` | `fe-u3` | U3: input components. **WIP**, `de72dc1`; components exist; check tests and finish |
| `/Users/rahulvuta/Desktop/Projects/NSA26-e0` | `codex-e0` | E0: economics data. **Not started** (empty) |

Python: run from `backend/` with `/Users/rahulvuta/Desktop/Projects/NSA26/.venv/bin/python -m pytest` and `... -m ruff check .`. That venv is Python 3.11; Homebrew 3.12 is broken on this Mac. Frontend: `cd web && npm test && npm run typecheck && npm run build`. Each FE folder has `node_modules` installed.

Local backend for the frontend:
```bash
cd /Users/rahulvuta/Desktop/Projects/NSA26-main/backend && ACRE_CORS_ORIGINS="http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,http://localhost:5177" /Users/rahulvuta/Desktop/Projects/NSA26/.venv/bin/python -m uvicorn acre.api.app:app --port 8000
```
Run it from whichever checkout has the newest merged backend.

## 4. State per track, and what your sub-agents must do

Check each agent's HANDOFF section first. It overrides anything here.

**Backend state** (branch `backend` at `73f4f7d`; tree clean):
- **S1** scenario engine and **S2** comparison/badges/money: **done in code, committed WIP** (`acre/simulate/{engine,seasons,money,compare,vocab}.py`, `acre/api/simulate_routes.py`). Verify with the full suite in a clean worktree, then run one Codex review.
- **S6:** `GET /v1/vocab/priorities` is done. **Not started:** `POST /v1/plans/autofill` (`acre/simulate/autofill.py`) and `GET /v1/demo/farm` (`acre/simulate/demo.py`). The exact algorithm is in log-A's HANDOFF.
- **S5** equipment/readings: **done** (`f925cfe`). **S3** economics: **done** (`02f214d`).
- **S4** crop library: **partial** (`f896244`). Remaining steps are in log-B's HANDOFF: full-suite check, a SQLite version cache, adding `/v1/crops/research` to the research rate class and budget in `acre/api/security.py`, contract regeneration, §13 notes, one Codex review.
- Known failing test: `tests/api/test_api_contract.py::test_committed_contract_files_are_current`. Regenerate with `python -m acre.api.contract`.

**Backend data, Track E0 (worktree `NSA26-e0`, branch `codex-e0`):** build `backend/data/economics/{prices,yields,costs,custom_rates}.csv` + `README.md`.
- Schemas are in log-B (the CSV schema B coded against) and in simulator.md.
- Sources: USDA NASS prices and yields, USDA ERS costs and returns, a university custom-rate survey, FAOSTAT prices and yields (AR, BR, IN, FR, US, CN, NG, KE, AU, MX).
- **Fetch real data with network access. Never invent numbers; omit and list gaps.**
- Merge into `backend` when done, then check that B's loader reads it.

**Frontend:**
- **U3** (`fe-u3`): finish and verify the input components: CropPicker with AI research, PlanEditor with "Fill typical dates", EconomicsEditor, EquipmentEditor, ReadingsLog, AreaSummary. Then `npm test` and typecheck. Push.
- **U1** (`fe-d`, integrator), at `f19b9b7`. The guided flow, adapter, state and Demo loader are built; U2 and U4 are merged and mounted. Left: fix the 5 failing tests in `web/src/screens/guided/guided.test.tsx`, merge `origin/fe-u3` and mount it via `screens/guided/slots.tsx`, write `web/tests/e2e/guided-demo.spec.ts`. Full detail is in log-D's HANDOFF on `fe-d`. The original brief: Build the 6-step guided flow: Your farm → What you do now → Simulate current plan → Try other plans → Compare → Your 10-year plan. Plus Demo mode and the adapter for §11–§16. Then merge `origin/fe-c`, `origin/fe-u2` and `origin/fe-u3` into `fe-d` and mount:
  - `sim/index.ts`: ScenarioResults, ScenarioCompare, BadgeRow, DeltaList;
  - `timeline/`: TenYearTimeline, TimelineCompare;
  - `inputs/`: the U3 components.
  The old NC dashboard stays reachable as "Union County deep-dive". Add one Playwright full-flow spec in Demo mode against the live backend.

## 5. Final integration (you, the lead)

1. Merge `backend` into `main` (with E0 merged into backend first). The full pytest suite and ruff must be green, plus `python -m acre.api.contract --check` (regenerate with `python -m acre.api.contract` if needed).
2. Merge `fe-d` (with everything merged) into `frontend/dev`, then into `main`. `npm test`, typecheck and build must be green.
3. Run the app locally against the backend: Demo mode end to end, Union County and Pergamino. Check in a browser that it's professional and very intuitive.
4. Push `main`. Render auto-deploys from `main` (`render.yaml`: `acre-api` + `acre-web`).

## 6. Non-negotiable rules (from CLAUDE.md §3)

- **Not a forecast:** 10-year futures replay past weather and say so.
- **Money:** the farmer's numbers or sourced references only; else blank with a reason. Weather affects money only through the farmer's own loss assumption, labelled `assumed`. No yield model.
- Blank is never 0. The exact 9 status words. `origin` on every value. AI is never `verified_source`. NC rules apply only in NC. Coordinates are never sent to the AI. No metric totals across fields (area only). "Best" means "best of the scenarios compared".
- Rate limits and security middleware stay on. Env vars are `ACRE_*`; old `FIELDSHIFT_*` names are still accepted.
- Git: never force-push. Stage only your track's paths. Commit often, with clear messages.
