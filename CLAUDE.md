# A.C.R.E / A.C.R.E: rules for all agents

A.C.R.E is a historical stress test for crop plans: it replays a farmer's plan against decades of NASA weather and the published agricultural guidance for that place. It is going global: any farm, drawn on a map, with fields that each have their own plan. The plan is in `docs/global/plan.md` and is the source of truth. The API contract is `docs/global/contract.md`.

Rahul owns the backend, with Claude Agents A and B. Abhi is back and owns the frontend (all former Agent C and D cards). Your launch prompt says which one you are. If it doesn't, ask before touching code.

| Agent | Side | Folder (worktree) | Branch |
|---|---|---|---|
| **A** | backend: weather, seasons, metrics, compare, farm API, contract, deploy | `/Users/rahulvuta/Desktop/Projects/NSA26` | `backend` |
| **B** | backend: geo, catalogs, rules, AI research, planner, field tools, reports | `/Users/rahulvuta/Desktop/Projects/NSA26` | `backend` |
| **Abhi** (+ his AI) | all frontend cards (former C and D, plus P4–P6) | his own checkout | `frontend/dev` |

Side rules still apply: `backend/CLAUDE.md` for A and B (engineering rules, status vocabulary, Codex gate), `web/CLAUDE.md` for C and D (theme kit, layout, no calculation). Where they disagree with this file on git, ownership or the remote, **this file wins**.

## 1. Git (hard rules)

- Remote `origin` = https://github.com/rahulvuta/A.C.R.E (private). Never push anywhere else. The old repo `abhijandyala/sa2026` is retired: never push to it.
- **A and B** commit only on `backend`, in the NSA26 folder. **Abhi** (the frontend) commits only on `frontend/dev` (or `frontend/*` branches merged into it). Before every push, `git rev-parse --abbrev-ref HEAD` must print your branch; if not, stop.
- **Never** commit to, merge into, reset, rebase or force-push `main`. Only Rahul's coordinating session merges `backend` and `frontend/dev` into `main` (at the end of each wave in the plan). Never force-push `backend` or `frontend/dev`.
- Two agents share each folder: stage only paths you own (`git add <your paths>`, or `git commit -- <paths>`), never `git add -A`, never revert or reformat files you don't own, never run a formatter over the whole tree.
- Frontend agents may `git merge origin/backend` into `frontend/dev` to pick up new endpoints (it only reads backend files). Backend agents never merge frontend branches.
- Commit after each card passes its review gate, then push. Pull first (`git pull --ff-only` or a normal merge; no rebase of pushed commits).
- End commit messages with the attribution line your session gives you.

## 2. File ownership

Only edit what you own. Need a change elsewhere? Write it in your log (`docs/global/log-<you>.md`) as `X→Y: ...` and carry on with a stub or fixture. Read the other agents' logs at the start of each card.

| Owner | Paths |
|---|---|
| A | `backend/acre/{weather,seasons,compare,api,farms}/`, `backend/acre/contracts.py`, `backend/acre/metrics/{winter,spring,thresholds}.py`, `backend/data/snapshots/`, `backend/data/samples/union_plans.json`, `backend/scripts/`, `backend/railway.json`, `backend/docs/api/`, `backend/docs/backend-runbook.md`, `docs/global/contract.md` (after G0) |
| B | `backend/acre/{geo,catalogs,research,planner,field,tools,report}/`, `backend/acre/metrics/{rules,rule_text}.py`, `backend/data/{catalogs/regions,catalogs/v3,geo}/`, `backend/data/samples/zones.json` |
| Abhi (was C) | `web/src/{map,farm,scene}/`, `web/tests/e2e/map*`, `web/tests/e2e/farm*` |
| Abhi (was D) | `web/src/{api,state,screens,view,content,site,ui,styles,data}/`, `web/src/{App,main,config}.tsx?`, `web/public/data/`, `web/scripts/`, `web/tests/e2e/` (other than C's files) |
| shared (small `Edit`, re-read right before) | `backend/pyproject.toml`, `backend/Makefile`, `web/package.json`, `web/package-lock.json` (only via `npm install <pkg>@<exact version>`), `web/vite.config.ts` |
| each agent its own | `docs/global/log-A.md` … `log-D.md`, tests next to its code (`backend/tests/<area>/`, `*.test.ts(x)` beside the file) |
| Rahul only | `CLAUDE.md` (this file), `docs/global/plan.md` (agents append nothing here; status goes in your log) |

Never edit `backend/data/catalogs/v1/` or `v2/` (Perplexity's verbatim files).

## 3. Science rules (both sides)

- **Historical simulation, never a forecast.** 10-year futures replay real past NASA seasons (historical resampling) and are labelled "not a forecast". Money results use the farmer's own numbers or sourced regional references (USDA NASS/ERS, university custom rates, FAOSTAT), never invented ones. Weather is converted into money only through a loss assumption the farmer enters, labelled `assumed`. No yield model, no "safe to plant". Live weather is context, never input. See `docs/global/simulator.md`.
- **Blank is not zero.** Missing = `null` plus a status. A real 0 stays 0.
- **Status vocabulary, exact strings:** `complete | partial | unavailable | unknown | inapplicable | unsupported | invalid_input | manual_check | insufficient_data`. Jobs additionally use `pending | ready | failed` in a separate `job_status` field, never in `status`.
- **Provenance on everything** (`origin` field, exact strings): `nasa_measured`, `nasa_modeled`, `calculation`, `verified_source` (a published source a human or the catalog verified), `source_checked` (AI-found, the quote was found on the cited page by code), `ai_suggested` (AI-found, not confirmed), `grower`, `assumed`, `dataset_estimate` (gridded dataset such as SAGE or SoilGrids). AI output is never `verified_source`.
- **NC rules apply only in NC.** A rule applies only where its region matches the location. Never borrow another region's numbers.
- **Resolution honesty:** a drawn boundary is exact, but NASA POWER weather is a ~0.5° × 0.625° cell and SoilGrids is ~250 m. Fields in one weather cell share one weather series; say so wherever results for several fields appear.
- **No sums across different calendars or datasets.** A farm overview may total area, never metrics.
- **Privacy:** farm boundaries, coordinates and grower inputs are never logged, never committed (fixtures are synthetic and labelled), never sent to the AI research step (it gets only the region: country, admin1, climate class). The frontend stores farms in the browser only.
- **Frontend computes no agronomy.** It may measure geometry for display (area, centroid) with turf; the backend recomputes area for any calculation.

## 4. Review gate (one review per milestone, not per card)

- **No Codex review per card.** While building, run only the tests for the area you are changing; run the full suite plus ruff (or `npm test` and typecheck) once before each push.
- **One Codex review per milestone**, covering all of that agent's cards in it, at `model_reasoning_effort="high"`. Milestones: **A:** after A2+P2, then after A3+A4. **B:** after B2+P1, then after P3. **Abhi:** his choice. Same command as `backend/CLAUDE.md` §4. Give the reviewer the card ids and `git diff <milestone-start>..HEAD --stat`, and save to `docs/global/reviews/<agent>-m<N>.md`.
- Run it in the background and keep building. When it lands, fix every high and medium finding in one pass. **No second review run**; reply to anything you skip in one line at the bottom of the review file. If Codex fails or hangs for more than 15 minutes, kill it, write `review skipped: <reason>` in your log, and continue.

## 5. Done means

The card's acceptance checks pass in tests (`pytest` + `ruff` for backend; `npm test`, `npm run typecheck`, and the card's Playwright spec for frontend), a status line is in your log: `YYYY-MM-DD <card>: done | what is left`. Then commit and push.
