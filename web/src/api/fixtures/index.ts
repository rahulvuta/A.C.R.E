/*
  Contract fixtures (docs/global/contract.md §2–§7), built by scripts/make-fixtures.mjs.
  All synthetic and labelled (`_fixture`); the geometry is invented. Used by unit tests,
  Playwright specs (as mocked route bodies) and the fixture mode (`?fixtures=1` with no
  VITE_API_BASE), which shows a "Sample responses" label on every screen that uses it.
*/
import type { FetchLike } from "../client";
import capabilitiesPending from "./capabilities-pending.json";
import capabilitiesPergamino from "./capabilities-pergamino.json";
import capabilitiesUnion from "./capabilities-union.json";
import farmInvalidBowtie from "./farm-invalid-bowtie.json";
import farmMixed from "./farm-mixed-nc-pergamino.json";
import farmThree from "./farm-three-fields-two-cells.json";
import farmTwo from "./farm-two-fields-one-cell.json";
import geoReverseOcean from "./geo-reverse-ocean.json";
import geoReversePergamino from "./geo-reverse-pergamino.json";
import geoReverseUnion from "./geo-reverse-union.json";
import geoSearchCoordinates from "./geo-search-coordinates.json";
import geoSearchEmpty from "./geo-search-empty.json";
import geoSearchPergamino from "./geo-search-pergamino.json";
import polygons from "./polygons.json";
import profileArB from "./profile-ar-b.json";
import profileUsNc from "./profile-us-nc.json";
import researchPending from "./research-pending.json";
import researchReady from "./research-ready.json";
import researchUnavailable from "./research-unavailable.json";
import toolsFertilizer from "./tools-fertilizer-area.json";
import weatherOffline from "./weather-offline.json";
import weatherPending from "./weather-pending.json";
import weatherReady from "./weather-ready.json";
import weatherUnion from "./weather-union.json";

export const FIXTURES = {
  capabilitiesPending,
  capabilitiesPergamino,
  capabilitiesUnion,
  farmInvalidBowtie,
  farmMixed,
  farmThree,
  farmTwo,
  geoReverseOcean,
  geoReversePergamino,
  geoReverseUnion,
  geoSearchCoordinates,
  geoSearchEmpty,
  geoSearchPergamino,
  profileArB,
  profileUsNc,
  researchPending,
  researchReady,
  researchUnavailable,
  toolsFertilizer,
  weatherOffline,
  weatherPending,
  weatherReady,
  weatherUnion,
} as const;
export type FixtureName = keyof typeof FIXTURES;

/** Fixture field polygons with each one's geodesic area (turf's formula); `bowtie` is invalid. */
export const POLYGONS = polygons.polygons;

/** Which saved place a point is near (fixture mode only): within 3° of Pergamino or Union County, else open water. */
function near(lat: number, lon: number): "pergamino" | "union" | "ocean" {
  if (Math.abs(lat + 33.89) < 3 && Math.abs(lon + 60.57) < 3) return "pergamino";
  if (Math.abs(lat - 34.98) < 3 && Math.abs(lon + 80.55) < 3) return "union";
  return "ocean";
}

type Answer = { status: number; body: unknown };

/** Answers one request from the fixtures. Exported so Playwright specs reuse the same routing. */
export function fixtureAnswer(url: string, init?: { method?: string; body?: string }): Answer {
  const u = new URL(url, "http://fixture.local");
  const path = u.pathname.replace(/^.*?(\/v1\/)/, "/v1/");
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const ok = (body: unknown): Answer => ({ status: 200, body });
  if (path === "/v1/geo/search") {
    const q = (u.searchParams.get("q") ?? "").trim();
    if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(q) || /°/.test(q)) return ok(FIXTURES.geoSearchCoordinates);
    return ok(/perg/i.test(q) ? FIXTURES.geoSearchPergamino : FIXTURES.geoSearchEmpty);
  }
  if (path === "/v1/geo/reverse") {
    const n = near(lat, lon);
    return ok(n === "pergamino" ? FIXTURES.geoReversePergamino : n === "union" ? FIXTURES.geoReverseUnion : FIXTURES.geoReverseOcean);
  }
  if (path === "/v1/locations/capabilities") {
    const n = near(lat, lon);
    return ok(n === "union" ? FIXTURES.capabilitiesUnion : n === "pergamino" ? FIXTURES.capabilitiesPergamino : FIXTURES.capabilitiesPending);
  }
  if (path === "/v1/weather/prepare") {
    const body = JSON.parse(init?.body ?? "{}") as { location?: { latitude?: number; longitude?: number } };
    const n = near(body.location?.latitude ?? 0, body.location?.longitude ?? 0);
    return ok(n === "union" ? FIXTURES.weatherUnion : n === "pergamino" ? FIXTURES.weatherReady : FIXTURES.weatherOffline);
  }
  if (path.startsWith("/v1/weather/")) return ok(FIXTURES.weatherReady);
  if (path === "/v1/farms/analyze") return ok(analyzeForRequest(init?.body));
  if (path === "/v1/regions/research") return ok(FIXTURES.researchPending);
  if (path.startsWith("/v1/regions/research/")) return ok(FIXTURES.researchReady);
  const prof = path.match(/^\/v1\/regions\/([^/]+)\/profile$/);
  if (prof) {
    const key = decodeURIComponent(prof[1] ?? "");
    if (key === "AR-B") return ok(FIXTURES.profileArB);
    if (key === "US-NC") return ok(FIXTURES.profileUsNc);
    return { status: 404, body: { detail: "no profile" } };
  }
  if (path.startsWith("/v1/tools/")) return ok(FIXTURES.toolsFertilizer);
  return { status: 404, body: { detail: "no fixture" } };
}

/**
 * The farm fixture, renamed to the request's own fields (fixture mode only): field i of the
 * request gets field i's sample result, so switching fields shows different results. Areas and
 * results stay the sample's; the screens label them "Sample responses".
 */
function analyzeForRequest(body: string | undefined): unknown {
  const req = JSON.parse(body ?? "{}") as { farm?: { fields?: Array<{ field_id: string; name: string }> } };
  const asked = req.farm?.fields ?? [];
  type F = { field_id: string; name: string; area_ha: number; area_ac: number };
  const base = (asked.length > 2 ? FIXTURES.farmThree : FIXTURES.farmTwo) as unknown as { fields: F[]; weather_cells: Array<{ cell_id: string; field_ids: string[]; note: string }> };
  if (asked.length === 0) return base;
  const fields = asked.map((f, i) => ({ ...(base.fields[i % base.fields.length] as F), field_id: f.field_id, name: f.name }));
  const idOf = new Map(base.fields.map((f, i) => [f.field_id, asked[i]?.field_id]));
  const weather_cells = base.weather_cells
    .map((c) => ({ ...c, field_ids: c.field_ids.map((id) => idOf.get(id)).filter((x): x is string => Boolean(x)) }))
    .filter((c) => c.field_ids.length > 0);
  // Fields beyond the sample's count join the first cell.
  for (const f of asked.slice(base.fields.length)) weather_cells[0]?.field_ids.push(f.field_id);
  // The stand-in for the backend's own area total (area is the only farm total).
  const sum = (k: "area_ha" | "area_ac") => Math.round(fields.reduce((a, f) => a + f[k], 0) * 100) / 100;
  return { ...base, fields, weather_cells, totals: { area_ha: sum("area_ha"), area_ac: sum("area_ac") } };
}

/** A `fetch` that answers from the fixtures, after an optional delay. */
export function fixtureFetch(delayMs = 0): FetchLike {
  return async (url, init) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (init?.signal?.aborted) throw new Error("aborted");
    const a = fixtureAnswer(url, init);
    const text = JSON.stringify(a.body);
    return { ok: a.status < 400, status: a.status, text: async () => text, headers: { get: () => "application/json" } };
  };
}

export const FIXTURE_API_BASE = "http://fixture.local";
