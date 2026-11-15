import { createInputsApi } from "../inputs/api";
import type { ZodType, ZodTypeDef } from "zod";
import {
  adaptCompare,
  adaptReplay,
  adaptSensitivity,
  BackendCompare,
  BackendRotations,
  BackendSensitivity,
  BackendYears,
  SavedWetness,
  shortcutsByPlant,
  toBackendPlan,
  type CompareExtras,
} from "./adapt";
import {
  adaptCapabilities,
  adaptFarmAnalysis,
  adaptGeoSearch,
  adaptIssues,
  adaptProfile,
  adaptResearch,
  adaptReverse,
  adaptWeather,
  BackendCapabilities,
  BackendFarmAnalysis,
  BackendGeoSearch,
  BackendIssues,
  BackendProfile,
  BackendResearch,
  BackendReverse,
  BackendWeather,
  toBackendFarm,
  adaptFuture,
  adaptGeneration,
  adaptRecommendation,
  BackendFuture,
  BackendGeneration,
  BackendRecommendation,
  toBackendGoals,
  toBackendPlace,
  toBackendPlanningField,
} from "./adapt";
import type { Capabilities, FarmAnalysis, FuturePlan, Generation, GeoSearch, Goals, InputIssue, PlaceInfo, PlanningField, PlanPlace, Recommendation, RegionProfile, ResearchJob, WeatherCell } from "./model";
import type { Farm } from "../farm/types";
import {
  BackendAutofill,
  BackendCropJob,
  BackendCropSearch,
  BackendDemo,
  BackendEconomics,
  BackendSimulation,
  BackendVocab,
  adaptAutofill,
  adaptCropJob,
  adaptCropSearch,
  adaptDemo,
  adaptEconomics,
  adaptSimulation,
  adaptVocab,
  toBackendAutofill,
  toBackendEconomics,
  toBackendSimulate,
  type SimulateRequest,
} from "./adapt";
import type { Autofill, CropJob, CropSearch, DemoFarm, Economics, Simulation, VocabItem } from "./simModel";
import { LocationResolveResponse, ReplayResponse, type CompareResponse, type PlanInput, type SensitivityResponse, type YearsResponse } from "./schema";

/*
  Two ways to get data, one interface:
  - the saved NASA record (public/data/nasa/): Rahul's real responses for the Union County
    sample, saved exactly as the service returned them, always available and offline;
  - the live backend (Render), used for date edits when VITE_API_BASE is set.
  Both go through adapt.ts, so a saved answer and a live answer are read the same way.
  Playbook p.30 and p.45, handbook p.14: bounded waits, visible failures, and a
  slow or older response can never replace a newer one.
*/

export type Origin = "saved" | "live";

export type Failure = {
  ok: false;
  kind: "timeout" | "network" | "not-found" | "parse" | "schema" | "stale" | "offline" | "invalid";
  message: string;
  detail?: string;
  /** For `invalid`: the backend's typed issues (HTTP 400 invalid_input), each naming its field. */
  issues?: InputIssue[];
};
export type Success<T> = { ok: true; data: T; origin: Origin };
export type Result<T> = Success<T> | Failure;

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers?: { get: (n: string) => string | null } }>;

export interface ClientOptions {
  sampleBase: string;
  apiBase?: string | null;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

function looksLikeHtml(contentType: string | null | undefined, body: string): boolean {
  if (contentType && contentType.toLowerCase().includes("text/html")) return true;
  return /^\s*</.test(body);
}

async function getJson<T>(
  url: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  opts: { timeoutMs: number; fetchImpl: FetchLike; init?: { method?: string; headers?: Record<string, string>; body?: string } },
): Promise<{ ok: true; data: T } | Failure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let text: string;
  try {
    const res = await opts.fetchImpl(url, { ...opts.init, signal: controller.signal });
    if (res.status === 404) return { ok: false, kind: "not-found", message: "That data file was not found." };
    if (res.status === 400) {
      let issues: InputIssue[] = [];
      try {
        const parsed = BackendIssues.safeParse(JSON.parse(await res.text()));
        if (parsed.success) issues = adaptIssues(parsed.data);
      } catch {
        /* a 400 without a readable body still says the input was refused */
      }
      return { ok: false, kind: "invalid", message: issues[0]?.message ?? "The service could not accept this input.", issues };
    }
    if (!res.ok) return { ok: false, kind: "network", message: `The service answered with an error (HTTP ${res.status}).` };
    text = await res.text();
    if (looksLikeHtml(res.headers?.get("content-type"), text)) {
      return { ok: false, kind: "not-found", message: "That data file was not found." };
    }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, kind: "timeout", message: "The service took too long to answer." };
    return { ok: false, kind: "network", message: "The service could not be reached.", detail: String(err) };
  } finally {
    clearTimeout(timer);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, kind: "parse", message: "The data is not valid JSON.", detail: String(err) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      kind: "schema",
      message: "The data does not match the agreed format.",
      detail: first ? `${first.path.join(".")}: ${first.message}` : undefined,
    };
  }
  return { ok: true, data: parsed.data };
}

export function createClient(opts: ClientOptions) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const base = { timeoutMs: opts.timeoutMs, fetchImpl };
  const sample = (name: string) => `${opts.sampleBase.replace(/\/$/, "")}/${name}.json`;
  const api = (path: string) => (opts.apiBase ? `${opts.apiBase.replace(/\/$/, "")}${path}` : null);

  async function saved<T>(name: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<Result<T>> {
    const r = await getJson(sample(name), schema, base);
    return r.ok ? { ok: true, data: r.data, origin: "saved" } : r;
  }

  /** Turns a parsed backend response into the screens' model; a mismatch is a visible failure, not a crash. */
  function adapted<T>(make: () => T, origin: Origin): Result<T> {
    try {
      return { ok: true, data: make(), origin };
    } catch (err) {
      const issue = (err as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues?.[0];
      return {
        ok: false,
        kind: "schema",
        message: "The data does not match the agreed format.",
        detail: issue ? `${issue.path.join(".")}: ${issue.message}` : String(err),
      };
    }
  }

  /** One plan per planting date: its /v1/years answer names that date's typical, dry and wet springs. */
  const plansByPlant = (c: BackendCompare) => {
    const seen = new Map<string, string>();
    for (const p of c.plans) if (p.plan && p.status !== "unavailable" && !seen.has(p.plan.next_plant)) seen.set(p.plan.next_plant, p.plan_id);
    return [...seen.values()];
  };

  return {
    hasLiveApi: Boolean(opts.apiBase),

    /** The saved Union County record: the judge path. Never needs the network beyond the site itself. */
    loadSample: async (): Promise<{ years: Result<YearsResponse>; compare: Result<CompareResponse>; sensitivity: Result<SensitivityResponse> }> => {
      const [raw, rotations, wetness, sweep] = await Promise.all([
        saved("compare", BackendCompare),
        saved("rotations", BackendRotations),
        saved("wetness", SavedWetness),
        saved("sensitivity", BackendSensitivity),
      ]);
      const sensitivity: Result<SensitivityResponse> = sweep.ok ? adapted(() => adaptSensitivity(sweep.data), "saved") : sweep;
      if (!raw.ok) return { years: raw, compare: raw, sensitivity };
      const yearFiles = await Promise.all(plansByPlant(raw.data).map((id) => saved(`years/${id}`, BackendYears)));
      const years: Result<YearsResponse> = yearFiles[0] ?? { ok: false, kind: "not-found", message: "That data file was not found." };
      const extras: CompareExtras = {
        rotations: rotations.ok ? rotations.data : null,
        wetness: wetness.ok ? wetness.data : null,
        shortcuts: shortcutsByPlant(yearFiles.map((y) => (y.ok ? y.data : null))),
      };
      return { years, compare: adapted(() => adaptCompare(raw.data, extras), "saved"), sensitivity };
    },

    /**
     * Daily detail for one season. Saved record by default; the live service when the
     * results on screen came from it (edited dates), so the detail matches the cards.
     */
    replay: async (year: number, planId: string, origin: Origin): Promise<Result<ReplayResponse>> => {
      const url = origin === "live" ? api(`/v1/seasons/${year}/replay?plan=${encodeURIComponent(planId)}`) : null;
      const r = url ? await getJson(url, ReplayResponse, base) : await saved(`replay/${encodeURIComponent(planId)}/${year}`, ReplayResponse);
      return r.ok ? { ok: true, data: adaptReplay(r.data), origin: url ? "live" : "saved" } : r;
    },

    /**
     * Recompute for edited dates or another place. Needs the live API; a failure keeps the
     * saved record on screen. The body is the backend's own: {location: {latitude, longitude},
     * plans: [{…, winter: {kind, …}, grower: {low_moisture_concern}}]}.
     */
    compare: async (plans: PlanInput[], location: LatLon): Promise<Result<CompareResponse>> => {
      const url = api("/v1/plans/compare");
      if (!url) return { ok: false, kind: "offline", message: "Editing dates needs the live service, which is not connected." };
      const r = await getJson(url, BackendCompare, {
        ...base,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ location: { latitude: location.latitude, longitude: location.longitude }, plans: plans.map(toBackendPlan) }),
        },
      });
      if (!r.ok) return r;
      // Typical, dry and wet springs come from /v1/years, which answers for the sample's own
      // dates. They are used only for a planting date that was not edited; a failure here is not fatal.
      const yearCalls = await Promise.all(plansByPlant(r.data).map((id) => getJson(api(`/v1/years?plan=${encodeURIComponent(id)}`)!, BackendYears, base)));
      const shortcuts = shortcutsByPlant(yearCalls.map((y) => (y.ok ? y.data : null)));
      return adapted(() => adaptCompare(r.data, { shortcuts }), "live");
    },

    /** Which grid cell a point falls in and whether weather history and guidance exist there (Phase 9). */
    resolveLocation: async (point: LatLon): Promise<Result<LocationResolveResponse>> => {
      const url = api("/v1/locations/resolve");
      if (!url) return { ok: false, kind: "offline", message: "Other places need the live service, which is not connected." };
      const r = await getJson(url, LocationResolveResponse, {
        ...base,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lat: point.latitude, lon: point.longitude, fetch_history: true }),
        },
      });
      return r.ok ? { ok: true, data: r.data, origin: "live" } : r;
    },
  };
}

export interface LatLon {
  latitude: number;
  longitude: number;
}

export type Client = ReturnType<typeof createClient>;

/**
 * Keeps only the newest answer. Each call gets a ticket; an answer whose ticket is no
 * longer the latest is dropped (handbook p.14). The backend's meta.request_id is shown
 * in evidence; ordering is enforced here on the client side.
 */
export function latestOnly() {
  let ticket = 0;
  return {
    next: () => ++ticket,
    isLatest: (t: number) => t === ticket,
  };
}

/*
  The global API (docs/global/contract.md §2–§7): map search, place, capabilities, weather
  on demand, farm analysis, regional profile and research. Every answer goes through
  adapt.ts. Without a service (no VITE_API_BASE) each call is an `offline` failure, so the
  screens say so instead of inventing data; tests and the fixture mode pass `fixtureFetch`.
  Coordinates go only in the request to the service, never in a log.
*/
/** A simulation replays ~200 seasons per plan; on a small server (or one waking up) that can take a minute. */
export const SIMULATE_TIMEOUT_MS = 120_000;

export function createGlobalClient(opts: { apiBase: string | null; timeoutMs: number; fetchImpl?: FetchLike }) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const base = { timeoutMs: opts.timeoutMs, fetchImpl };
  const api = (path: string) => (opts.apiBase ? `${opts.apiBase.replace(/\/$/, "")}${path}` : null);
  const offline: Failure = { ok: false, kind: "offline", message: "This needs the A.C.R.E service, which is not connected in this build." };
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const coords = (p: LatLon) => `lat=${encodeURIComponent(p.latitude)}&lon=${encodeURIComponent(p.longitude)}`;

  async function call<B, T>(
    path: string,
    schema: ZodType<B, ZodTypeDef, unknown>,
    make: (b: B) => T,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
    timeoutMs = base.timeoutMs,
  ): Promise<Result<T>> {
    const url = api(path);
    if (!url) return offline;
    const r = await getJson(url, schema, { ...base, timeoutMs, init });
    if (!r.ok) return r;
    try {
      return { ok: true, data: make(r.data), origin: "live" };
    } catch (err) {
      const issue = (err as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues?.[0];
      return { ok: false, kind: "schema", message: "The data does not match the agreed format.", detail: issue ? `${issue.path.join(".")}: ${issue.message}` : String(err) };
    }
  }

  return {
    inputs: createInputsApi(opts.apiBase ?? "", opts.apiBase ? fetchImpl : async () => { throw new Error(offline.message); }),
    hasLiveApi: Boolean(opts.apiBase),
    geoSearch: (q: string, limit = 5): Promise<Result<GeoSearch>> =>
      call(`/v1/geo/search?q=${encodeURIComponent(q)}&limit=${limit}`, BackendGeoSearch, adaptGeoSearch),
    geoReverse: (p: LatLon): Promise<Result<PlaceInfo>> => call(`/v1/geo/reverse?${coords(p)}`, BackendReverse, adaptReverse),
    capabilities: (p: LatLon): Promise<Result<Capabilities>> => call(`/v1/locations/capabilities?${coords(p)}`, BackendCapabilities, adaptCapabilities),
    prepareWeather: (p: LatLon, refresh = false): Promise<Result<WeatherCell>> =>
      call("/v1/weather/prepare", BackendWeather, adaptWeather, post({ location: { latitude: p.latitude, longitude: p.longitude }, refresh })),
    weather: (cellId: string): Promise<Result<WeatherCell>> => call(`/v1/weather/${encodeURIComponent(cellId)}`, BackendWeather, adaptWeather),
    analyzeFarm: (farm: Farm): Promise<Result<FarmAnalysis>> => call("/v1/farms/analyze", BackendFarmAnalysis, adaptFarmAnalysis, post(toBackendFarm(farm))),
    regionProfile: (regionKey: string): Promise<Result<RegionProfile>> =>
      call(`/v1/regions/${encodeURIComponent(regionKey)}/profile`, BackendProfile, adaptProfile),
    startResearch: (regionKey: string): Promise<Result<ResearchJob>> => call("/v1/regions/research", BackendResearch, adaptResearch, post({ region_key: regionKey })),
    research: (jobId: string): Promise<Result<ResearchJob>> => call(`/v1/regions/research/${encodeURIComponent(jobId)}`, BackendResearch, adaptResearch),
    /** §8: candidate rotations for one field. */
    generate: (place: PlanPlace, goals: Goals | null, field?: PlanningField): Promise<Result<Generation>> =>
      call("/v1/plans/generate", BackendGeneration, adaptGeneration, post({ ...toBackendPlace(place), ...(field ? { field: toBackendPlanningField(field) } : {}), ...(goals ? { goals: toBackendGoals(goals) } : {}) })),
    /** §9: the Pareto shortlist for one field (candidates from the generator unless given). */
    recommend: (place: PlanPlace, goals: Goals | null, field?: PlanningField, candidates?: Array<Record<string, unknown>>): Promise<Result<Recommendation>> =>
      call(
        "/v1/plans/recommend",
        BackendRecommendation,
        adaptRecommendation,
        post({ ...toBackendPlace(place), ...(field ? { field: toBackendPlanningField(field) } : {}), ...(goals ? { goals: toBackendGoals(goals) } : {}), ...(candidates ? { candidates } : {}) }),
      ),
    /** §10: the multi-season future plan for a candidate (raw, from generate) or one plan. */
    future: (place: PlanPlace, what: { candidate: Record<string, unknown> } | { plan: Record<string, unknown> }, startSeason: string, seasons = 2, edits?: Array<{ field: string; value: unknown }>): Promise<Result<FuturePlan>> =>
      call("/v1/plans/future", BackendFuture, adaptFuture, post({ ...toBackendPlace(place), ...what, start_season: startSeason, seasons, ...(edits?.length ? { edits } : {}) })),

    // ---- Scenario Simulator (§11–§16)
    /** §11: simulate the baseline and up to 5 alternatives over 10 years of resampled past weather. */
    simulate: (q: SimulateRequest): Promise<Result<Simulation>> => call("/v1/scenarios/simulate", BackendSimulation, adaptSimulation, post(toBackendSimulate(q)), Math.max(base.timeoutMs, SIMULATE_TIMEOUT_MS)),
    /** §12: sourced prices, yields and costs for these crops at this place (the farmer's overrides win). */
    economics: (q: Parameters<typeof toBackendEconomics>[0]): Promise<Result<Economics>> => call("/v1/economics/estimate", BackendEconomics, adaptEconomics, post(toBackendEconomics(q))),
    /** §13: the shared crop library. */
    searchCrops: (q: string, regionKey: string | null): Promise<Result<CropSearch>> =>
      call(`/v1/crops/search?q=${encodeURIComponent(q)}${regionKey ? `&region_key=${encodeURIComponent(regionKey)}` : ""}`, BackendCropSearch, adaptCropSearch),
    /** §13: research an unknown crop (only the name and region are sent). */
    researchCrop: (name: string, regionKey: string | null): Promise<Result<CropJob>> => call("/v1/crops/research", BackendCropJob, adaptCropJob, post({ name, region_key: regionKey })),
    cropJob: (jobId: string): Promise<Result<CropJob>> => call(`/v1/crops/research/${encodeURIComponent(jobId)}`, BackendCropJob, adaptCropJob),
    /** §14, §16: vocabularies with plain labels. */
    vocab: (which: "equipment" | "readings" | "priorities"): Promise<Result<VocabItem[]>> => call(`/v1/vocab/${which}`, BackendVocab, adaptVocab),
    /** §15: a complete demo farm (example values). */
    demoFarm: (scenario: "union" | "pergamino"): Promise<Result<DemoFarm>> => call(`/v1/demo/farm?scenario=${scenario}`, BackendDemo, (r) => adaptDemo(r)),
    /** §15: typical dates for the chosen crops at this place, each with its origin. */
    autofill: (point: LatLon, crops: Array<{ role: "previous" | "cover" | "next"; cropId: string }>): Promise<Result<Autofill>> =>
      call("/v1/plans/autofill", BackendAutofill, adaptAutofill, post(toBackendAutofill(point, crops))),
  };
}
export type GlobalClient = ReturnType<typeof createGlobalClient>;
