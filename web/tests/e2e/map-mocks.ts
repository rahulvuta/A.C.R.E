import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

/*
  Route mocks for the map specs: map tiles get a blank PNG, and the backend (served at
  http://api.test) answers from D's contract fixtures in src/api/fixtures/.
*/
export const API = "http://api.test";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../src/api/fixtures");
export const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8"));

// 1×1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export async function mockTiles(page: Page) {
  const tile = (r: Route) => r.fulfill({ status: 200, contentType: "image/png", body: PNG });
  await page.route("https://server.arcgisonline.com/**", tile);
  await page.route("https://tile.openstreetmap.org/**", tile);
}

export type Handler = (url: URL) => { status?: number; body: unknown } | null;

/** Mock the backend. Each handler gets the URL and returns a body, or null to pass. */
export async function mockApi(page: Page, handlers: Handler[]) {
  const calls: string[] = [];
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    calls.push(`${route.request().method()} ${url.pathname}${url.search}`);
    for (const h of handlers) {
      const r = h(url);
      if (r) return route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.body), headers: { "access-control-allow-origin": "*" } });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ issues: [{ message: "not mocked" }] }), headers: { "access-control-allow-origin": "*" } });
  });
  return calls;
}

/** The default geo mocks: Pergamino by name, coordinates parsed, Pergamino or Union by point. */
export const geoHandlers: Handler[] = [
  (u) => {
    if (u.pathname !== "/v1/geo/search") return null;
    const q = u.searchParams.get("q") ?? "";
    if (/pergamino/i.test(q)) return { body: fixture("geo-search-pergamino") };
    if (/^-?\d/.test(q.trim())) return { body: fixture("geo-search-coordinates") };
    return { body: fixture("geo-search-empty") };
  },
  (u) => {
    if (u.pathname !== "/v1/geo/reverse") return null;
    const lat = Number(u.searchParams.get("lat"));
    return { body: fixture(lat < 0 ? "geo-reverse-pergamino" : "geo-reverse-union") };
  },
  (u) => {
    if (u.pathname !== "/v1/locations/capabilities") return null;
    const lat = Number(u.searchParams.get("lat"));
    return { body: fixture(lat < 0 ? "capabilities-pergamino" : "capabilities-union") };
  },
];

/** Open the map harness against the mocked API and wait for the map to load. */
export async function openMap(page: Page, harness = "harness.html", extra = "") {
  await mockTiles(page);
  await page.goto(`/src/map/${harness}?api=${encodeURIComponent(API)}${extra}`);
  await page.locator(".mp-map[data-ready='true']").waitFor();
}

/** The map's centre as [lat, lon], read from the container's mirror attribute. */
export async function mapCenter(page: Page): Promise<[number, number]> {
  const c = await page.locator(".mp-map").getAttribute("data-center");
  const [lat, lon] = (c ?? "0,0").split(",").map(Number);
  return [lat!, lon!];
}
