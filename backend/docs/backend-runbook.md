# A.C.R.E backend runbook

> Run every command below from the `backend/` folder (`cd backend`). Hosting: Railway, configured by `railway.json` (service root directory `backend`, start `python -m uvicorn acre.api.app:app --host 0.0.0.0 --port $PORT`, health check `/health`).

Backend only. The frontend reads the contract in `docs/api/openapi.json` and the generated examples in `docs/api/examples/`.

## 1. Run it offline

The core calculations and the sample run from files in the repo; no network, no database server.

```bash
uv sync                      # Python 3.12, FastAPI, pydantic v2, pandas, httpx, pyarrow
make offline-demo            # ACRE_OFFLINE=1 uvicorn acre.api.app:app
curl localhost:8000/health
curl -X POST localhost:8000/v1/plans/compare -H 'content-type: application/json' \
     -d '{"rotation_ids": ["current_practice", "winter_cover"]}'
```

With `ACRE_OFFLINE=1`, weather comes only from the committed snapshots under `data/snapshots/` (`index.json` lists them: Union plus seven more NC counties) and no live provider (NWS, USDM, USDA SDA, NASA POWER) is called. A provider with a still-valid on-disk cache entry (SDA 30 days, `data/cache/`, not committed, so empty in a fresh clone) is answered from it and labelled `cached(<time>)`; otherwise it is reported `unavailable`; plan comparison, replay, sensitivity and years all still work. A test (`tests/api/test_api_contract.py::test_offline_demo_...`) starts a fresh process that refuses every non-loopback connection and exercises those endpoints.

Python 3.12 is the target. The code is also 3.11-compatible (no PEP 695 syntax) because the Homebrew 3.12 on one development Mac has a broken `pyexpat`.

## 2. Tests and checks

```bash
make test                    # uv run python -m pytest   (offline; live providers are mocked)
make lint                    # ruff check .
python -m acre.api.contract --check   # exit 1 if docs/api is stale
python -m acre.weather verify         # raw/ -> daily.parquet reproduction + hashes
python -m acre.weather report         # first/last valid date per variable
```

`tests/api/test_api_contract.py` validates every example response against `docs/api/openapi.json`, and fails when the committed contract files drift from the code. Regenerate them with `python -m acre.api.contract` (offline).

Reproduce a replay without the API, from `raw/` alone (standard library only):

```bash
python scripts/reproduce_replay.py --raw data/snapshots/union_county/raw/power_daily.json \
  --plans data/samples/union_plans.json --plan corn_soy__rye --year 2008
```

## 3. Method notes

**Weather source.** NASA POWER Daily API v2.10.3, `community=AG`, point query, parameters `PRECTOTCORR` (MERRA-2 bias-corrected precipitation, mm/day), `T2M_MAX`, `T2M_MIN`, `T2M`, `GWETTOP`, `GWETROOT` (modeled soil wetness, 0-1). Fill value -999; time standard LST (Local Solar Time). The series starts 1981-01-01, so the winter that begins in fall 1980 is incomplete: winter 1981 is `partial`, giving 44 complete winters and 45 complete springs through 2025. The point echoes the request; the 0.5 x 0.625 degree MERRA-2 cell is derived, not returned by the API. The Union County point (Monroe, NC) is **assumed** until the handbook lands.

**Normalization.** Fill values, negative precipitation/wetness, wetness above 1, null/blank/non-numeric values and absent dates are missing with a reason; a real 0 stays 0. Duplicate dates are de-duplicated (first wins) and logged. The table is reindexed to every calendar day.

**Windows.** Plans are `MM-DD` anchored per year; Feb 29 resolves to Feb 28 in non-leap years. Winter window `[prev_harvest, next_plant)`; living-cover interval `[seed, terminate)` labelled `planned` (establishment uncertain; the termination day is not cover); spring window `[next_plant - 30 d, next_plant - 1 d]`; termination gap `next_plant - terminate`.

**Frozen thresholds.** Computed once per request from the whole 1981-2025 record, held in an immutable `ThresholdSet`, and shared by every plan and both eras.
- Heavy-rain day: daily `precip_mm >= 76.2` (3 in), the published "very heavy rain" definition (catalog v2 `fc_v2_ref_very_heavy_rain`, `data/catalogs/v2/weather_references.csv`; NC Climate Science Report: Plain Language Summary, March 2020, PDF p. 4). Source URL and locator are frozen into `thresholds.heavy_rain.source`. POWER daily values are Local Solar Time days, not a rolling 24 h window, so a storm split across two solar days can miss the line; the threshold note says so. It is a rainfall-depth weather metric only, never erosion, runoff or soil loss. Most winters have zero qualifying days (6 days >= 76.2 mm fall in Sep-May over 1981-2025); a zero is a real result, and total rain outside living cover is the main winter indicator. The earlier relative P95 rule was dropped from the ThresholdSet (still available as an explicit `HeavyRainRule` option for experiments).
- Dry spring: the `ceil(20% of n)`-th smallest 30-day total among complete 1981-2025 windows for that planting date (45 eligible years gives the 9th smallest). Years equal to the cutoff count as dry.
- Rank 1 = driest; ties share the lowest rank; percentile is the share of eligible years at or below the total.

**Eras.** Earlier 1981-2000, recent 2006-2025; 2001-2005 are in neither (still in the full record and replay). Each era needs >= 15 of 20 evaluable seasons or the result is `insufficient_data`. `|diff| < 10` percentage points is `similar`. Descriptive only; each label ships with fixed text and no trend, cause or forecast claim. Cross-plan comparisons are also given on the years every plan could be evaluated for.

**Rules.** The rule engine (`acre/metrics/rules.py`) evaluates the Perplexity catalogs against one `SeasonFacts` per season. `cr_tt_03` (rye to soybean): flagged when the gap is under 14 days and (the replay is dry or the grower reports a low-moisture concern); clears at 14 days or more. Conflicting rules (`fc_pw_01`/`fc_pw_02`, `sb_pw_01`/`sb_pw_04`) are both surfaced.

**Sensitivity.** Termination dates from the day after seeding through planting; with the fixed 14-day rule the check count is a step function (the dry-year count below 14 days, 0 at or above). A date whose gap crosses Feb 29 reports `gap_days_in_leap_years`.

## 4. Error taxonomy

HTTP 400 is only for invalid input (typed `{field, code, message}` issues); everything else is a 200 with a status in the body, so a partial result is preserved. Unknown paths/methods (404/405) and unexpected errors (500, no detail beyond a fixed code) use the same envelope with the four metadata fields.

| Card term | Where it appears | Status string |
|---|---|---|
| `invalid_input` | HTTP 400 `{status, issues[{field, code, message}], meta fields}` | `invalid_input` |
| `unsupported` | per plan / per response (unknown crop, or a point outside North Carolina: code `unsupported_location`) | `unsupported` |
| `unavailable` | an NC point whose grid cell has no committed snapshot: code `no_weather_snapshot`, `meta.snapshot_hash` null | `unavailable` |
| `unknown_evidence` | a rule or metric that lacks an input | `unknown` (or `manual_check` for qualitative rules) |
| `unavailable_data` | weather window missing, provider down, catalog rows missing (`reason: catalog_missing`) | `unavailable` / `partial` |
| `inapplicable` | a rule that does not apply to this crop, region or system | `inapplicable` |

Other statuses: `complete`, `partial`, `insufficient_data` (era or cutoff has too few evaluable seasons), `manual_check`.

## 5. Providers, timeouts, cache policy, freshness

| Provider | Used for | Timeout | Cache policy | Offline behaviour |
|---|---|---|---|---|
| NASA POWER Daily | weather history (build only) | 120 s, 3 retries (2 s, 4 s, 8 s backoff) | permanent: the committed snapshot in `data/snapshots/` | never called at serve time; `python -m acre.weather build` (Union) and `build-locations` (the counties) are the only fetches |
| USDA SDA | soil | 15 s | 30 days on disk (`data/cache/sda`, gitignored) | `cached(<time>)` if a valid copy exists, else `unavailable` |
| NWS API | forecast / alerts | 10 s | 15 min / 5 min | `unavailable` |
| US Drought Monitor | county drought | 10 s | 6 h | `unavailable` |

Freshness labels: `fresh | cached(<time>) | snapshot | unavailable`. `data_sources` in the comparison response states the label per input; weather history is always `snapshot`. An expired cached copy is never reported as current.

## 6. Logging and privacy

The access log records method, path (no query string), status and duration only; request and response bodies are never logged. uvicorn's own access log has its query strings stripped, and any log message that mentions `grower`, `residue_report`, `observations` or `low_moisture_concern` is replaced by a fixed placeholder (whole-message redaction, because values cannot be parsed out of free text safely). Fixtures and examples are synthetic or the real public NASA series; there is no real grower data in the repo.

## 7. Sources

- NASA POWER Daily API and parameter metadata: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
- Catalogs v1 (`data/catalogs/v1/`, verbatim from Perplexity, each row with `source_url`, `source_locator`, `verified_date`).
- USDA NRCS Soil Data Access, NWS API, US Drought Monitor (Agent B's `acre/field`).
- Handbooks (`Field-Shift-Backend-Rahul.pdf`, `Field-Shift-Charlotte-Playbook-2.pdf`): the team's original documents, local only (gitignored), reference only. The Union County point and sample plan dates remain labelled assumptions; the heavy-rain rule is the published 76.2 mm definition above.

## 8. Known gaps

Winter wheat double-crop and SMAP (Phase 12) are not built; the wheat path returns `unavailable: catalog_missing`. Catalog gaps are listed at the top of `docs/phase-cards.md` and in `docs/catalog-gaps.md`.

## Weather locations (per-county snapshots)

`data/snapshots/index.json` lists every place with a committed snapshot: `union`, `iredell`, `rowan`, `johnston`, `wayne`, `duplin`, `pitt`, `robeson` (county-centre points from the web place picker, not farms). One snapshot is stored per NASA POWER grid cell (0.5 x 0.625 degrees): Johnston and Wayne share a cell, so Wayne is served from `data/snapshots/johnston/` and carries the same `snapshot_hash`. Each snapshot has the same source, span (1981-01-01 to 2025-06-30), manifest format and hash rule as Union County's.

- **Choosing a place.** Compare, replay, sensitivity, years and the Phase 9 routes read `location_id` (an index id; `union_county_sample` still means Union) or a latitude/longitude (`location: {latitude, longitude}` in a body, or `latitude`/`longitude` in a query). The lookup is by grid cell, so any point inside a served cell uses that snapshot. No place means the Union County default, exactly as before.
- **Meta.** `meta.snapshot_hash` is the snapshot actually used. `weather_location` says which place answered, its region, grid cell and hash, and where the thresholds come from.
- **Thresholds.** Each place gets its own frozen `ThresholdSet`: dry-spring cutoffs from its own 1981-2025 baseline, heavy rain the fixed 76.2 mm. Locations are never mixed in a threshold set, era comparison or shared-year set (one request is one place).
- **No snapshot.** A North Carolina point whose cell has no snapshot returns HTTP 200 `unavailable`, code `no_weather_snapshot`, `reason_text`, `meta.snapshot_hash: null`. A point outside NC stays `unsupported_location`. An unknown `location_id`, or an id and a point that disagree, is HTTP 400 `invalid_input`.
- **Adding a county.** Add it to `PLACES` in `acre/weather/locations.py`, then `python -m acre.weather build-locations` (needs the network once; refuses under `ACRE_OFFLINE=1`; fetches only missing cells; compares a place that shares a cell with the stored history and stops if they differ). `python -m acre.weather verify-locations` checks the index and every snapshot offline. Regenerate the contract afterwards.

## Global deployment (A4)

### Railway service

- Root directory `backend`, start command and health check in `railway.json` (`/health`).
- **Run one process (one uvicorn worker).** Weather fetches are de-duplicated per grid cell inside the process. Two workers could fetch the same cell at once. That is safe (each writes its own temporary folder and renames it into place) but wastes a POWER call.
- **Attach a Railway volume and point `ACRE_CACHE_DIR` at it** (for example mount `/data`, set `ACRE_CACHE_DIR=/data/acre`). Without a volume every redeploy starts with an empty cache and re-fetches each cell.
  - `<cache>/weather/<cell_id>/<snapshot_hash>/`: one NASA POWER snapshot per grid cell (raw response, `daily.parquet`, `manifest.json`), about 1.6 MB raw + 0.4 MB parquet per cell. `current.json` names the served hash. A refresh adds a new hash folder and never rewrites an old one. Delete old hash folders by hand if space matters; nothing else references them.
  - `<cache>/geo/`: geocoder cache (B1). `<cache>/regions/`: research profiles (B3).
  - The cache holds no farm data: weather is fetched for the cell centre, never the farm point, and the backend stores no farm, field or boundary.
- The 8 NC county snapshots are committed in `data/snapshots/` and always win over the cache.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `ACRE_CACHE_DIR` | `backend/data/cache` (gitignored) | Weather, geocoder and research caches. Use the Railway volume. |
| `ACRE_OFFLINE` | unset | `1`: never touch the network. Committed NC snapshots and whatever is already cached are served; anything else answers `unavailable` / `offline_no_snapshot`. |
| `ACRE_POWER_TIMEOUT_S` | `120` | Timeout per NASA POWER request. Each fetch is retried once. |
| `ACRE_CORS_ORIGINS` | GitHub Pages + local Vite ports | Comma-separated allowed origins. Set it to the deployed frontend's origin. |
| `OPENROUTER_API_KEY` | unset | AI regional research (B3), through OpenRouter. Without it research answers `unavailable` / `research_not_configured` and the SAGE-only profiles are served. Never logged. |
| `ACRE_RESEARCH_MODEL` | `anthropic/claude-sonnet-4.5` | OpenRouter model slug for AI research. Any listed model works; changing it changes the cache key. |
| `ACRE_RESEARCH_DOMAINS` | unset | Comma-separated extra source domains the guardrails accept (besides `.gov`, `.gov.xx`, `.gob.xx`, `.gouv.fr`, `.edu`, `.ac.xx`, FAO, CGIAR, INTA, ICAR, extension and university hosts). |

### Cost and rate limits

- **NASA POWER** is free and needs no key. One fetch per grid cell (1981-01-01 to yesterday, 6 parameters, about 15 s and 1.6 MB). It is fetched once and then served from the cache. Only `refresh: true` re-fetches. POWER asks clients not to flood it: the one-fetch-per-cell rule and the two background fetch threads keep the load low.
- **Nominatim (OSM)**: at most 1 request per second, a generic User-Agent, results cached (B1). Coordinate input is parsed locally and never sent.
- **AI research via OpenRouter (B3)**: billed per token. `POST https://openrouter.ai/api/v1/chat/completions` with the `web` plugin (8 results), a strict JSON schema, temperature 0 and a fixed seed. One job per region key at a time. The prompt (versioned `PROMPT_VERSION`) gets only the country, admin1, Köppen class and SAGE crop list, never coordinates, farm data or SAGE windows.
  - **Pipeline:** AI → schema check (one retry with the errors appended, then `job_status: failed`, `research_bad_output`) → guardrails (`research/guardrails.py`) → quote check against the fetched page → cache.
  - **Guardrails:** off-vocabulary crop ids, condition keys, units, operators or rule types drop the row. A missing URL drops it, and an off-allowlist domain caps it at `ai_suggested`. Out-of-range numbers and invalid MM-DD drop it. A planting or harvest window outside SAGE ± 30 days is `manual_check` ("disagrees with gridded crop calendar"). Quotes are ≤ 30 words; rows are capped at 60 and sorted. If more than half the items are dropped, the profile gets the gap "AI output failed guardrails".
  - **Cache:** the key is sha256(prompt version + model + region query + vocabulary version). The same key is served from `<cache>/regions/<key>/` unless `refresh: true`. That folder holds `profile.json` (with `generation: {model, prompt_version, cache_key, guardrail_version}`), `crop_rules.csv`, `raw_response.json` and `guardrails.json` (every drop, downgrade and flag with its reason).
  - **Errors:** `research_not_configured`, `rate_limited`, `provider_error`, `research_timeout` (plus `research_truncated`, `research_bad_output`).
- **SoilGrids / Open-Meteo / USDA SDA / NWS / USDM**: free; cached per provider (B4).

### Smoke test

```bash
python scripts/smoke_global.py seed --cache /tmp/fs-cache      # recorded Pergamino POWER response, no network
ACRE_OFFLINE=1 ACRE_CACHE_DIR=/tmp/fs-cache python -m uvicorn acre.api.app:app --port 8765
python scripts/smoke_global.py run --base http://127.0.0.1:8765
```
Without a server: `ACRE_OFFLINE=1 ACRE_CACHE_DIR=/tmp/fs-cache python scripts/smoke_global.py run --inprocess` sends the same requests to the app in-process (FastAPI TestClient).

It walks search → reverse → capabilities → weather prepare and poll → farm analyze → recommend → field note → regional profile for the NC demo (committed snapshot) and Pergamino (the seeded cell), and checks every `status` against the nine status words.
