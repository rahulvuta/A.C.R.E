# Map and place search: what each service asks (card 32)

Read on 16 November 2026. This is a summary of each provider's published pages, not legal advice.
Where a page was not read or did not settle a point, it says so.

## Short answer

| Service | Used for | Fine for a demo and light use? | For a public site with real traffic |
|---|---|---|---|
| Esri World Imagery | Satellite photo a field is drawn on | Not confirmed | Needs your own ArcGIS account and key. **Your decision.** |
| OpenStreetMap tiles | Street map | Yes, with the credit shown | No guarantee of service. Move to a tile provider if traffic grows. |
| OpenStreetMap Nominatim | Finding a town by name | Yes, under 1 request a second | Same service is fine while traffic is low. Name the site in the User-Agent. |
| NASA GIBS | Greenness and soil moisture pictures | Yes | Yes. No key. Credit NASA GIBS. |
| NASA POWER | Weather records | Yes | Yes. No key. Credit the POWER project. |

The app works without the satellite photo: a grower can search for a town, type the field's
size and skip the drawing (card 17). So switching the photo off is a real fallback, not a broken
page.

## Esri World Imagery (satellite photo)

**What Esri publishes.** The World Imagery item page says the layer is licensed under the Esri
Master License Agreement, that it is not for exporting tiles for offline use, and gives the
credit line "Esri, Vantor, Earthstar Geographics, and the GIS User Community". Esri's developer
guide says its location services need an ArcGIS Location Platform or ArcGIS Online account.

**What was not confirmed.** No page read says a public website may load these tiles with no
account and no key. The app does that today, as many open-source map examples do. Treat it as
not permitted for a public launch until Esri's terms say otherwise.

**What the app does.** Shows the credit line on the map at all times (never collapsed). Does not
store tiles: the offline mode keeps the app's own files and saved results only, never map tiles.

**What a public launch needs (your decision).** One of:

1. Create an ArcGIS Location Platform account, make an API key for basemap tiles, and build with
   `VITE_SATELLITE_TILES` set to the keyed tile address and `VITE_SATELLITE_ATTRIBUTION` set to
   Esri's credit line. Creating the account and key is yours to do; a key in a web page is
   visible to visitors, so restrict it to the site's address in Esri's dashboard.
2. Use another imagery provider with a key (set the same two settings).
3. Build with `VITE_SATELLITE_TILES=off`. The map opens on the street map and the grower types
   the field's size.

## OpenStreetMap tiles (street map)

**What the tile usage policy asks.** Show the "© OpenStreetMap contributors" credit on the map.
Let the browser send its normal Referer (no restrictive Referrer-Policy). Honour the tiles'
caching headers. No bulk downloading, no prefetching, no offline use. Do not hard-code the tile
address, so the app can move if access changes. The service is run by volunteers on donated
servers, is best-effort, and access can be withdrawn.

**What the app does.** Credit always visible, with a link. No Referrer-Policy is set, so the
browser sends its default. Tiles are fetched only as the grower moves the map; nothing is
prefetched; the service worker does not cache tiles from other sites. The tile address is now a
build setting (`VITE_STREET_TILES`, `VITE_STREET_ATTRIBUTION`).

**What a public launch needs.** Nothing while traffic is light. If the site becomes busy, or
tiles start failing, move to a tile provider by changing the two settings. No code change.

## OpenStreetMap Nominatim (place search)

**What the usage policy asks.** At most 1 request a second in total from the application. A
User-Agent or Referer that identifies the application (a library's stock User-Agent is not
accepted). No autocomplete (no search on each keystroke). Cache results. No bulk or systematic
queries. Show the OpenStreetMap credit. Access can be withdrawn, and an application must be able
to switch to another service.

**What the app does.**

- All searches go through the backend, which sends one request at a time and at most one a
  second for the whole service, and keeps every answer on disk so the same question is asked
  once.
- Search runs when the grower presses Search, never while typing.
- The User-Agent names the application (`ACRE-crop-planner/0.1 (NASA Space Apps 2026 project)`)
  and holds no personal contact.
- "Place search © OpenStreetMap contributors" is now shown under the search results, whichever
  base map is on.
- The query text is never logged. A pin's place name is looked up with the point rounded to
  about 1 km.
- The service, its User-Agent, a key and the credit are settings, so it can be switched with no
  code change:
  `ACRE_GEOCODER_URL`, `ACRE_GEOCODER_USER_AGENT`, `ACRE_GEOCODER_KEY`
  (`ACRE_GEOCODER_KEY_PARAM`, default `key`), `ACRE_GEOCODER_ATTRIBUTION`,
  `ACRE_GEOCODER_ATTRIBUTION_URL`.

**What a public launch needs.** Set `ACRE_GEOCODER_USER_AGENT` to a name that includes the
site's address, so the operators can tell who is asking. If searches ever exceed what one
request a second can serve, point `ACRE_GEOCODER_URL` at a hosted or self-hosted Nominatim. The
key setting is covered by a unit test and has not been tried against a real keyed service.

## NASA GIBS (greenness and soil moisture pictures)

No key and no login; the service allows requests from any website. NASA asks that GIBS be
credited. The app credits NASA GIBS on the map whenever a layer is on and on the credits page.
The soil moisture figure on the results is read from one map picture about 600 km across, so the
request does not locate the field.

## NASA POWER (weather records)

No key. The POWER project asks for an acknowledgement, which is on the credits page. The app
asks for grid-cell centres, never a field's own point, and keeps what it has fetched.

## Settings in one place

Build time, web (`web/`):

| Setting | Default | Meaning |
|---|---|---|
| `VITE_SATELLITE_TILES` | Esri World Imagery | Tile address with `{z}` `{x}` `{y}`, or `off` |
| `VITE_SATELLITE_ATTRIBUTION` | Esri's credit line | Credit for the address above |
| `VITE_STREET_TILES` | OpenStreetMap | Tile address with `{z}` `{x}` `{y}` |
| `VITE_STREET_ATTRIBUTION` | OpenStreetMap's credit | Credit for the address above |

A tile address must start with `https://`. A new address with no attribution setting shows no
credit rather than the previous provider's.

Run time, backend (`backend/`):

| Setting | Default | Meaning |
|---|---|---|
| `ACRE_GEOCODER_URL` | `https://nominatim.openstreetmap.org` | A service that speaks Nominatim's `/search` and `/reverse` |
| `ACRE_GEOCODER_USER_AGENT` | `ACRE-crop-planner/0.1 (NASA Space Apps 2026 project)` | How this deployment names itself |
| `ACRE_GEOCODER_KEY` | none | Sent as a query parameter when set |
| `ACRE_GEOCODER_KEY_PARAM` | `key` | Name of that parameter |
| `ACRE_GEOCODER_ATTRIBUTION` | `Place search © OpenStreetMap contributors` | Credit shown with results |
| `ACRE_GEOCODER_ATTRIBUTION_URL` | OpenStreetMap's copyright page | Link for the credit |

## Pages read

- Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/
- OpenStreetMap tile usage policy: https://operations.osmfoundation.org/policies/tiles/
- Esri World Imagery item (licence and credit fields): https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9
- Esri developer guide on accounts for location services: https://developers.arcgis.com/documentation/
- NASA GIBS: https://earthdata.nasa.gov/gibs
