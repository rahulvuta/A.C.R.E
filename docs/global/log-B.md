# Agent B log

Status lines (`YYYY-MM-DD <card>: done | what is left`) and handoffs (`B→X: ...`). Only Agent B edits this file.


## B1 handoffs (2026-11-14)

- B→A: **`fieldshift.geo.capabilities.capabilities_for(lat, lon, *, allow_network=True) -> dict`** exists (library call for A3). Never raises. Shape = contract §4 body without `meta`: `status, reason, reason_text, region_key, region_keys, features{weather, catalog, soil, live_weather, drought, tools}`. `features.weather` is your `ondemand.capability()` verbatim. Water / bad point gives `status: unsupported|invalid_input`, `features: null`.
- B→A: the geo routes (`GET /v1/geo/search`, `GET /v1/geo/reverse`, `GET /v1/locations/capabilities`) are **already served by the production app**: `field/routes.py` includes `fieldshift.geo.routes.router`. Don't mount it again in `app.py`. **Please regenerate `docs/api/openapi.json`** (`test_committed_contract_files_are_current` fails until then; B2/P1 add more routes, so once at the end of your card is fine).
- B→A: `fieldshift.geo.locate.describe(lat, lon, allow_network=True)` gives `Description` (place {country ISO2, admin1 ISO 3166-2, admin2, display}, hemisphere, on_land, climate {koppen, label, resolution_km, source, origin: dataset_estimate, coastal_neighbour}, cell_id, region_keys, nc_region, in_nc).
- B→A,C,D: `region_keys` chain is `[<ISO2>-<admin1>, <ISO2>, koppen:<class>]`, e.g. `["AR-B", "AR", "koppen:Cfa"]`. NC points: `["US-NC", "US", "koppen:Cfa"]`.
- B→C,D: `/v1/geo/search` rounds coordinates to 2 dp; coordinate-like text that doesn't parse is a 400 `invalid_coordinates` and is never sent to Nominatim. Geocoder down → 200 `status: unavailable` + `reason`.
- B→A: `POST /v1/locations/resolve` is now worldwide (B-owned `field/location.py`): only water is `unsupported_location`; outside NC guidance is `unknown` with a pointer to the region profile. Adds `hemisphere, on_land, climate, region_keys, nc_region, place`.
- Geocoder cache: `$FIELDSHIFT_CACHE_DIR/geo/`.

2026-11-14 B1: done | geo search/reverse (Nominatim, cache, 1 req/s, generic UA, coordinate and DMS parsing, coordinate-like text never sent out), Köppen 0.1° raster, hemisphere, cell id, land check, region-key chain, worldwide `locations/resolve`, `capabilities_for()` with A1's weather state. Review: B1.md CHANGES NEEDED (5 fixed), B1-r2.md CHANGES NEEDED (3 fixed after it: bracketed coordinate pairs, 2-dp rounding in resolve, malformed geocoder rows). Left: openapi.json regen (A).
