# A.C.R.E / Field Shift: rules for all agents

Field Shift is a historical stress test for crop plans: it replays a farmer's plan against decades of NASA weather and the published agricultural guidance for that place. It is going global: any farm, drawn on a map, with fields that each have their own plan. The plan is in `docs/global/plan.md` and is the source of truth. The API contract is `docs/global/contract.md`.

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
| A | `backend/fieldshift/{weather,seasons,compare,api,farms}/`, `backend/fieldshift/contracts.py`, `backend/fieldshift/metrics/{winter,spring,thresholds}.py`, `backend/data/snapshots/`, `backend/data/samples/union_plans.json`, `backend/scripts/`, `backend/railway.json`, `backend/docs/api/`, `backend/docs/backend-runbook.md`, `docs/global/contract.md` (after G0) |
| B | `backend/fieldshift/{geo,catalogs,research,planner,field,tools,report}/`, `backend/fieldshift/metrics/{rules,rule_text}.py`, `backend/data/{catalogs/regions,catalogs/v3,geo}/`, `backend/data/samples/zones.json` |
| Abhi (was C) | `web/src/{map,farm,scene}/`, `web/tests/e2e/map*`, `web/tests/e2e/farm*` |
| Abhi (was D) | `web/src/{api,state,screens,view,content,site,ui,styles,data}/`, `web/src/{App,main,config}.tsx?`, `web/public/data/`, `web/scripts/`, `web/tests/e2e/` (other than C's files) |
| shared (small `Edit`, re-read right before) | `backend/pyproject.toml`, `backend/Makefile`, `web/package.json`, `web/package-lock.json` (only via `npm install <pkg>@<exact version>`), `web/vite.config.ts` |
| each agent its own | `docs/global/log-A.md` … `log-D.md`, tests next to its code (`backend/tests/<area>/`, `*.test.ts(x)` beside the file) |
| Rahul only | `CLAUDE.md` (this file), `docs/global/plan.md` (agents append nothing here; status goes in your log) |

Never edit `backend/data/catalogs/v1/` or `v2/` (Perplexity's verbatim files).

## 3. Science rules (both sides)

- **Historical stress test only.** No forecasts, yields, profit or "safe to plant". Live weather is context, never input to the analysis.
- **Blank is not zero.** Missing = `null` plus a status. A real 0 stays 0.
- **Status vocabulary, exact strings:** `complete | partial | unavailable | unknown | inapplicable | unsupported | invalid_input | manual_check | insufficient_data`. Jobs additionally use `pending | ready | failed` in a separate `job_status` field, never in `status`.
- **Provenance on everything** (`origin` field, exact strings): `nasa_measured`, `nasa_modeled`, `calculation`, `verified_source` (a published source a human or the catalog verified), `source_checked` (AI-found, the quote was found on the cited page by code), `ai_suggested` (AI-found, not confirmed), `grower`, `assumed`, `dataset_estimate` (gridded dataset such as SAGE or SoilGrids). AI output is never `verified_source`.
- **NC rules apply only in NC.** A rule applies only where its region matches the location. Never borrow another region's numbers.
- **Resolution honesty:** a drawn boundary is exact, but NASA POWER weather is a ~0.5° × 0.625° cell and SoilGrids is ~250 m. Fields in one weather cell share one weather series; say so wherever results for several fields appear.
- **No sums across different calendars or datasets.** A farm overview may total area, never metrics.
- **Privacy:** farm boundaries, coordinates and grower inputs are never logged, never committed (fixtures are synthetic and labelled), never sent to the AI research step (it gets only the region: country, admin1, climate class). The frontend stores farms in the browser only.
- **Frontend computes no agronomy.** It may measure geometry for display (area, centroid) with turf; the backend recomputes area for any calculation.

## 4. Review gate (every card)

After each card, run the Codex review from `backend/CLAUDE.md` §4 (same command; frontend agents run it from `web/` with `-C "$PWD"` and save to `../docs/global/reviews/<card>.md`, backend agents save to `../docs/global/reviews/<card>.md` from `backend/`). Use `model_reasoning_effort="high"` for A1–A3 and B2–B3, `"medium"` for every other card. Run it in the background and **start the next card while it runs**; fix high and medium findings when it lands, one re-run at most (`<card>-r2.md`). If Codex fails, write `review skipped: <reason>` in your log and continue.

## 5. Done means

The card's acceptance checks pass in tests (`pytest` + `ruff` for backend; `npm test`, `npm run typecheck`, and the card's Playwright spec for frontend), the review gate ran, and a status line is in your log: `YYYY-MM-DD <card>: done | what is left`. Then commit and push.
