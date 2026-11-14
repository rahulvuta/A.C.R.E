/*
  What the map needs from the backend (contract §3–4): place search, reverse geocode and the
  capabilities of a point, in D's model (api/model.ts). The map takes any `GeoApi`; D's api/
  layer provides the real one through adapt.ts. `createFetchGeoApi` is a thin stand-in so the
  map can be built and tested before that lands: it maps only the fields the map shows, and
  D replaces it. Coordinates are never logged here.
*/
import type { Capabilities, Capability, CapabilityKey, GeoSearch, PlaceInfo } from "../api/model";
import type { Origin } from "../farm/types";
import { Status } from "../api/schema";

export type GeoResult<T> = { ok: true; data: T } | { ok: false; message: string };

export interface GeoApi {
  search(q: string, signal?: AbortSignal): Promise<GeoResult<GeoSearch>>;
  reverse(lat: number, lon: number, signal?: AbortSignal): Promise<GeoResult<PlaceInfo>>;
  capabilities(lat: number, lon: number, signal?: AbortSignal): Promise<GeoResult<Capabilities>>;
}

const TIMEOUT_MS = 15000;
type Fetch = typeof fetch;

async function getJson(url: string, fetchImpl: Fetch, signal?: AbortSignal): Promise<GeoResult<unknown>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, message: "The service sent an answer the map could not read." };
    }
    if (!res.ok) {
      const msg = (body as { issues?: Array<{ message?: string }> })?.issues?.[0]?.message;
      return { ok: false, message: msg ? String(msg) : `The service answered with an error (HTTP ${res.status}).` };
    }
    return { ok: true, data: body };
  } catch {
    if (signal?.aborted) return { ok: false, message: "Cancelled." };
    if (controller.signal.aborted) return { ok: false, message: "The service took too long to answer." };
    return { ok: false, message: "The service could not be reached." };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

type J = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): J | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : null);
// Only the nine status words get through; anything else is reported as unknown.
type StatusWord = PlaceInfo["status"];
const WORDS = new Set<string>(Status.options);
const status = (v: unknown): StatusWord => (typeof v === "string" && WORDS.has(v) ? (v as StatusWord) : "unknown");

export function parseSearch(body: unknown): GeoResult<GeoSearch> {
  const b = obj(body);
  if (!b || !Array.isArray(b.results)) return { ok: false, message: "The search answer had no results list." };
  const hits: GeoSearch["hits"] = [];
  for (const raw of b.results) {
    const r = obj(raw);
    const lat = num(r?.latitude);
    const lon = num(r?.longitude);
    if (!r || lat === null || lon === null) continue; // a result without a point cannot be shown
    const bb = Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((x) => num(x) !== null) ? (r.bbox as [number, number, number, number]) : null;
    hits.push({ label: str(r.label) ?? `${lat}, ${lon}`, point: { latitude: lat, longitude: lon }, bbox: bb, kind: str(r.kind) ?? "place" });
  }
  return { ok: true, data: { queryKind: b.query_kind === "coordinates" ? "coordinates" : "text", hits } };
}

export function parseReverse(body: unknown): GeoResult<PlaceInfo> {
  const b = obj(body);
  if (!b || typeof b.status !== "string") return { ok: false, message: "The place answer had no status." };
  const p = obj(b.place);
  const c = obj(b.climate);
  return {
    ok: true,
    data: {
      status: status(b.status),
      reasonText: str(b.reason_text),
      display: str(p?.display),
      country: str(p?.country),
      countryName: str(p?.country_name),
      admin1: str(p?.admin1),
      admin1Name: str(p?.admin1_name),
      admin2Name: str(p?.admin2_name),
      hemisphere: b.hemisphere === "north" || b.hemisphere === "south" ? b.hemisphere : null,
      onLand: b.on_land === true,
      climate:
        c && str(c.koppen)
          ? { code: str(c.koppen)!, label: str(c.label) ?? "", resolutionKm: num(c.resolution_km), source: str(c.source) ?? "", origin: (str(c.origin) ?? "dataset_estimate") as Origin }
          : null,
      cellId: str(b.cell_id),
      regionKeys: Array.isArray(b.region_keys) ? b.region_keys.filter((k): k is string => typeof k === "string") : [],
      ncRegion: str(b.nc_region),
    },
  };
}

const KEYS: CapabilityKey[] = ["weather", "catalog", "soil", "live_weather", "drought", "tools"];

export function parseCapabilities(body: unknown): GeoResult<Capabilities> {
  const b = obj(body);
  const f = obj(b?.features);
  if (!b || !f) return { ok: false, message: "The capabilities answer had no features." };
  const features: Capability[] = KEYS.map((key) => {
    const v = obj(f[key]);
    if (key === "tools") {
      const parts = v ? Object.entries(v).map(([k, s]) => ({ key: k, status: status(s) })) : [];
      // One word for the group only when every tool agrees; otherwise "partial", or "unknown" if none.
      const words = new Set(parts.map((p) => p.status));
      const overall: StatusWord = parts.length === 0 ? "unknown" : words.size === 1 ? parts[0]!.status : "partial";
      return { key, status: overall, jobStatus: null, origin: null, provider: null, resolutionM: null, reasonText: null, parts };
    }
    const job = v?.job_status;
    return {
      key,
      status: v ? status(v.status) : "unknown",
      jobStatus: job === "pending" || job === "ready" || job === "failed" ? job : null,
      origin: (str(v?.origin) as Origin | null) ?? null,
      provider: str(v?.provider),
      resolutionM: num(v?.resolution_m),
      reasonText: str(v?.reason_text),
      parts: [],
    };
  });
  return { ok: true, data: { regionKey: str(b.region_key), features } };
}

export function createFetchGeoApi(base: string, fetchImpl: Fetch = (...a) => fetch(...a)): GeoApi {
  const root = base.replace(/\/$/, "");
  return {
    async search(q, signal) {
      const r = await getJson(`${root}/v1/geo/search?q=${encodeURIComponent(q)}&limit=5`, fetchImpl, signal);
      return r.ok ? parseSearch(r.data) : r;
    },
    async reverse(lat, lon, signal) {
      const r = await getJson(`${root}/v1/geo/reverse?lat=${lat}&lon=${lon}`, fetchImpl, signal);
      return r.ok ? parseReverse(r.data) : r;
    },
    async capabilities(lat, lon, signal) {
      const r = await getJson(`${root}/v1/locations/capabilities?lat=${lat}&lon=${lon}`, fetchImpl, signal);
      return r.ok ? parseCapabilities(r.data) : r;
    },
  };
}

/** Round a picked point before it is sent (5 decimals ≈ 1 m; enough to place a pin). */
export function roundCoord(v: number, places = 5): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
