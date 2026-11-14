# Agent C log

Status lines (`YYYY-MM-DD <card>: done | what is left`) and handoffs (`C→X: ...`). Only Agent C edits this file.

2026-11-14 C1 (Abhi): done | the three open findings in `reviews/C1-r2.md` are fixed.
- `map/geoApi.ts`: the field-tools row says "partial" only when at least one tool can be used (`toolsStatus`). Mixed words with none usable give "unavailable", or "unknown" if any tool was not reported. Negative mixed cases added to `geoApi.test.ts`.
- `tests/e2e/map-search.spec.ts`: the held search route is now registered after the default mocks, so it is the one that answers. The test waits for the request, clicks, and waits for the page to drop the request (the app cancels the search on a click) before releasing it.
- New specs: a click on a repeated copy of the world sends a longitude inside -180..180 (`map-search.spec.ts`), and a place picked or typed while the tiles are held gets its pin and view once the map loads (`map-early.spec.ts`, `holdTiles` in `map-mocks.ts`).
- Run: `npx playwright test -c tests/e2e/map.config.ts` gives 10 passed. Start `npx vite --port 5174 --strictPort` first if Playwright's own server start fails; something else on port 5174 makes every spec fail at `page.goto`.
2026-11-14 C2 (Abhi): in progress | the failing "fixture polygon area within 0.1%" test is fixed on the fixture side. `@turf/area` 7.4.0 uses the mean Earth radius (6371008.8 m). The fixture's `area_ha` values had been computed on a sphere of the equatorial radius (6378137 m) and read 0.22 to 0.25 percent high. They are now the geodesic area on the WGS84 ellipsoid (102.61, 138.49, 164.10, 82.07, 68.88 ha); the display area agrees to within 0.04 percent at these latitudes. The three farm fixtures that repeat those figures, their acres and their totals were updated to match.
C→A: please compute field area on the WGS84 ellipsoid (pyproj `Geod.geometry_area_perimeter`, or equal). A spherical area with the equatorial radius would differ from the map's display by about 0.22 percent everywhere. Near the equator and the poles the display itself can differ from the ellipsoid by up to about 0.3 percent, so the 0.1 percent check holds at mid latitudes only.

