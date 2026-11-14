# Agent D log

Status lines (`YYYY-MM-DD <card>: done | what is left`) and handoffs (`D→X: ...`). Only Agent D edits this file.

2026-11-14 port (Abhi): merged today's frontend work from the retired sa2026 repo into `frontend/dev` (branch `frontend/port-nov14`, two commits). What it brings: a saved NASA record per county under `web/public/data/nasa/<place>/` (8 places, 1,800 replays, about 103 MB on disk, about 10 MB packed); every live call names its place (`location_id`, or a point in the body); edited dates send the plan itself to `POST /v1/seasons/{year}/replay` and `POST /v1/plans/sensitivity`; compare sends `include_soil: false`; live wait is 45 s; the 3D field shrinks away instead of dropping when hidden; wheat, second-winter, data and privacy wording corrected. Three overlaps resolved by hand (`index.html`, `config.ts`, `LocationDrawer.tsx`); D1's fixture mode and global timeout kept. `npm run typecheck` clean, 287 of 288 tests pass (the remaining failure is C2's fixture polygon area), build passes, demo route checked in the browser for Union and Johnston.
D→Rahul: `.github/workflows/deploy-web.yml` is not a frontend path, so I left it as it is. To let the build reach a live service, the `npm run build` step needs `env: VITE_API_BASE: ${{ vars.VITE_API_BASE }}`.

