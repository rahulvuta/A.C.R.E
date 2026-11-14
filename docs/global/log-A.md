# Agent A log

Status lines (`YYYY-MM-DD <card>: done | what is left`) and handoffs (`A→X: ...`). Only Agent A edits this file.


## A1 handoffs (2026-11-14)

- A→C,D: **`cell_id` format is `cell_<lat %+.3f>_<lon %+.3f>`** (e.g. `cell_-34.000_-60.625`), the format the NC API already used. The G0 draft's `lat-34.00_lon-60.625` is gone; contract §1, §2, §3 and §5 are updated.
- A→C,D: `POST /v1/weather/prepare` / `GET /v1/weather/{cell_id}` shipped (contract §2). New in the body beyond the draft: `poll` (set only when pending), `notes[]`, `coverage.complete_off_seasons`, `coverage.basis`, request field `wait_s` (0–120). Pending has `status: "unknown"`. Reasons: `offline_no_snapshot | power_unreachable | power_error | power_bad_response | power_no_data | cache_write_failed | not_prepared` (GET of a cell nobody prepared). `source` is `committed | cache | fetched | null`.
- A→B: `fieldshift.weather.ondemand.capability(lat, lon)` returns the `features.weather` block for `/v1/locations/capabilities` (`status, job_status, cell_id, source, reason, reason_text, origin`). It never starts a fetch. Note the origin: POWER daily values are MERRA-2 reanalysis, so it is **`nasa_modeled`**, not `nasa_measured` as in the contract §4 draft (I changed §4).
- A→B: `ondemand.cache_root()` is `$FIELDSHIFT_CACHE_DIR` (default `backend/data/cache/`, gitignored). Weather lives under `<root>/weather/`; put the geocoder/soil/research caches in sibling folders.

2026-11-14 A1: done | on-demand POWER weather per grid cell (`fieldshift/weather/ondemand.py`, `POST /v1/weather/prepare`, `GET /v1/weather/{cell_id}`), cache under `$FIELDSHIFT_CACHE_DIR/weather/<cell_id>/<hash>/`, dedupe, one retry, offline, refresh-to-new-hash, recorded Pergamino fixture. Review: A1.md CHANGES NEEDED (4 fixed: httpx URL logging, temp pointer cleanup, failed refresh visible to polling, signed-zero cell ids), A1-r2.md PASS. Left: cross-process dedupe (one process per Railway service, noted for the A4 runbook).
