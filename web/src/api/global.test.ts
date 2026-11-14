import { describe, expect, it } from "vitest";
import {
  adaptCapabilities,
  adaptFarmAnalysis,
  adaptGeoSearch,
  adaptProfile,
  adaptResearch,
  adaptReverse,
  adaptWeather,
  BackendCapabilities,
  BackendFarmAnalysis,
  BackendGeoSearch,
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
} from "./adapt";
import { createGlobalClient, type FetchLike } from "./client";
import { FIXTURE_API_BASE, FIXTURES, fixtureFetch, POLYGONS, type FixtureName } from "./fixtures";
import { ORIGINS } from "./model";
import type { Farm } from "../farm/types";

// Each contract fixture with the schema and adapter that read it.
const READERS: Record<FixtureName, (raw: unknown) => unknown> = {
  capabilitiesPending: (r) => adaptCapabilities(BackendCapabilities.parse(r)),
  capabilitiesPergamino: (r) => adaptCapabilities(BackendCapabilities.parse(r)),
  capabilitiesUnion: (r) => adaptCapabilities(BackendCapabilities.parse(r)),
  farmInvalidBowtie: (r) => r, // a 400 body; read by the client (tested below)
  farmMixed: (r) => adaptFarmAnalysis(BackendFarmAnalysis.parse(r)),
  farmThree: (r) => adaptFarmAnalysis(BackendFarmAnalysis.parse(r)),
  farmTwo: (r) => adaptFarmAnalysis(BackendFarmAnalysis.parse(r)),
  futureUnion: (r) => adaptFuture(BackendFuture.parse(r)),
  generateUnion: (r) => adaptGeneration(BackendGeneration.parse(r)),
  recommendUnion: (r) => adaptRecommendation(BackendRecommendation.parse(r)),
  geoReverseOcean: (r) => adaptReverse(BackendReverse.parse(r)),
  geoReversePergamino: (r) => adaptReverse(BackendReverse.parse(r)),
  geoReverseUnion: (r) => adaptReverse(BackendReverse.parse(r)),
  geoSearchCoordinates: (r) => adaptGeoSearch(BackendGeoSearch.parse(r)),
  geoSearchEmpty: (r) => adaptGeoSearch(BackendGeoSearch.parse(r)),
  geoSearchPergamino: (r) => adaptGeoSearch(BackendGeoSearch.parse(r)),
  profileArB: (r) => adaptProfile(BackendProfile.parse(r)),
  profileUsNc: (r) => adaptProfile(BackendProfile.parse(r)),
  researchPending: (r) => adaptResearch(BackendResearch.parse(r)),
  researchReady: (r) => adaptResearch(BackendResearch.parse(r)),
  researchUnavailable: (r) => adaptResearch(BackendResearch.parse(r)),
  toolsFertilizer: (r) => r, // B4; read in D3/D4
  weatherOffline: (r) => adaptWeather(BackendWeather.parse(r)),
  weatherPending: (r) => adaptWeather(BackendWeather.parse(r)),
  weatherReady: (r) => adaptWeather(BackendWeather.parse(r)),
  weatherUnion: (r) => adaptWeather(BackendWeather.parse(r)),
};

// Maps keyed by data (plan dates, indicators, parameters) rather than field names: a new key there is new data, not a new field.
const RECORDS = new Set(["eras", "eras_shared_years", "dry_spring", "missing_days", "thresholds_by_plant"]);
/** Adds an unknown field at the top level and inside every object, as a newer backend might. */
function withExtras(v: unknown, inRecord = false): unknown {
  if (Array.isArray(v)) return v.map((x) => withExtras(x));
  if (v && typeof v === "object") {
    const inner = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inRecord ? withExtras(x) : withExtras(x, RECORDS.has(k))]));
    return inRecord ? inner : { ...inner, zz_new_field: { nested: [1, "x"] } };
  }
  return v;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("contract fixtures", () => {
  it.each(Object.keys(FIXTURES) as FixtureName[])("%s parses through the adapter", (name) => {
    expect(() => READERS[name](clone(FIXTURES[name]))).not.toThrow();
  });

  it.each(Object.keys(FIXTURES) as FixtureName[])("%s tolerates unknown fields", (name) => {
    expect(() => READERS[name](withExtras(clone(FIXTURES[name])))).not.toThrow();
  });

  it("every fixture is labelled synthetic", () => {
    for (const f of Object.values(FIXTURES)) expect((f as { _fixture?: string })._fixture).toMatch(/Synthetic fixture/);
  });

  it("fixture polygons carry an area, except the bowtie", () => {
    expect(POLYGONS.bowtie.valid).toBe(false);
    expect(POLYGONS.bowtie.area_ha).toBeNull();
    for (const [k, p] of Object.entries(POLYGONS)) if (k !== "bowtie") expect(p.area_ha).toBeGreaterThan(10);
  });
});

describe("geo and capabilities", () => {
  it("reads the Pergamino place", () => {
    const p = adaptReverse(BackendReverse.parse(FIXTURES.geoReversePergamino));
    expect(p).toMatchObject({ country: "AR", admin1: "AR-B", hemisphere: "south", onLand: true, ncRegion: null });
    expect(p.climate).toMatchObject({ code: "Cfa", origin: "dataset_estimate" });
    expect(p.regionKeys).toEqual(["AR-B", "AR", "koppen:Cfa"]);
  });

  it("open water is unsupported, with its sentence", () => {
    const p = adaptReverse(BackendReverse.parse(FIXTURES.geoReverseOcean));
    expect(p.status).toBe("unsupported");
    expect(p.onLand).toBe(false);
    expect(p.reasonText).toMatch(/open water/);
  });

  it("lists every capability in a fixed order, unknown when left out", () => {
    const c = adaptCapabilities(BackendCapabilities.parse({ region_key: "AR-B", features: { weather: { status: "complete" } } }));
    expect(c.features.map((f) => f.key)).toEqual(["weather", "catalog", "soil", "live_weather", "drought", "tools"]);
    expect(c.features.find((f) => f.key === "soil")!.status).toBe("unknown");
  });

  it("keeps Pergamino's statuses and origins", () => {
    const c = adaptCapabilities(BackendCapabilities.parse(FIXTURES.capabilitiesPergamino));
    const by = Object.fromEntries(c.features.map((f) => [f.key, f]));
    expect(by.catalog).toMatchObject({ status: "partial", origin: "ai_suggested" });
    expect(by.soil).toMatchObject({ provider: "soilgrids", resolutionM: 250, origin: "dataset_estimate" });
    expect(by.drought).toMatchObject({ status: "unavailable", reasonText: expect.stringMatching(/drought/) });
    expect(by.tools!.parts).toEqual([
      { key: "irrigation", status: "complete" },
      { key: "fertilizer", status: "partial" },
    ]);
  });

  it("an origin it does not know is never shown as verified", () => {
    const c = adaptCapabilities(BackendCapabilities.parse({ features: { catalog: { status: "complete", origin: "verified-ish" } } }));
    expect(c.features[1]!.origin).toBe("ai_suggested");
  });
});

describe("weather", () => {
  it("pending carries the poll path and no coverage", () => {
    const w = adaptWeather(BackendWeather.parse(FIXTURES.weatherPending));
    expect(w).toMatchObject({ jobStatus: "pending", coverage: null, poll: "/v1/weather/lat-34.00_lon-60.000" });
  });
  it("offline says why", () => {
    const w = adaptWeather(BackendWeather.parse(FIXTURES.weatherOffline));
    expect(w).toMatchObject({ jobStatus: "failed", status: "unavailable" });
    expect(w.reasonText).toMatch(/offline/);
  });
  it("ready keeps the cell size and note", () => {
    const w = adaptWeather(BackendWeather.parse(FIXTURES.weatherReady));
    expect(w.sizeDeg).toEqual([0.5, 0.625]);
    expect(w.note).toMatch(/One NASA POWER weather series/);
  });
});

describe("farm analysis", () => {
  const two = adaptFarmAnalysis(BackendFarmAnalysis.parse(FIXTURES.farmTwo));
  const three = adaptFarmAnalysis(BackendFarmAnalysis.parse(FIXTURES.farmThree));
  const mixed = adaptFarmAnalysis(BackendFarmAnalysis.parse(FIXTURES.farmMixed));

  it("two fields in one cell share one weather series", () => {
    expect(two.weatherCells).toHaveLength(1);
    expect(two.weatherCells[0]!.fieldIds).toEqual(["fld_1", "fld_2"]);
    expect(two.weatherCells[0]!.note).toMatch(/share one NASA weather series/);
  });

  it("three fields in two cells: two groups, the pending field has no result", () => {
    expect(three.weatherCells).toHaveLength(2);
    const east = three.fields.find((f) => f.fieldId === "fld_3")!;
    expect(east.jobStatus).toBe("pending");
    expect(east.result).toBeNull();
  });

  it("totals hold area only", () => {
    expect(Object.keys(two.totals).sort()).toEqual(["areaAc", "areaHa"]);
  });

  it("a Southern Hemisphere field reads its off-season label and its own cutoffs", () => {
    const r = two.fields[0]!.result!;
    expect(r.hemisphere).toBe("south");
    expect(r.seasonLabel).toBe("Off-season (May–Oct)");
    expect(r.springLabel).toBe("30 days before planting");
    expect(r.thresholds.heavyRainMethod).toBe("etccdi_r95p");
    expect(r.thresholds.heavyRain!.origin).toBe("calculation");
    expect(r.thresholds.drySpring!.value).toBe(FIXTURES.farmTwo.fields[0]!.result.spring.cutoff_mm);
    expect(r.springWindow!.years).toHaveLength(45);
  });

  it("two fields with different plans give different results", () => {
    const [a, b] = two.fields.map((f) => f.result!);
    expect(a!.plan.sequence!.next_crop_id).toBe("soybean");
    expect(b!.plan.sequence!.next_crop_id).toBe("maize");
    expect(a!.plan.winter!.per_season_median.rain_mm_without_cover).not.toBe(b!.plan.winter!.per_season_median.rain_mm_without_cover);
  });

  it("an NC field keeps 'Winter' and its verified rule lines; the Pergamino field has no NC rule", () => {
    const nc = mixed.fields.find((f) => f.fieldId === "fld_nc")!.result!;
    expect(nc.seasonLabel).toBe("Winter");
    expect(nc.rules.length).toBeGreaterThan(0);
    expect(nc.rules.every((r) => r.origin === "verified_source")).toBe(true);
    const perg = mixed.fields.find((f) => f.fieldId === "fld_1")!.result!;
    const ncIds = new Set(nc.rules.map((r) => r.ruleId));
    expect(perg.rules.some((r) => ncIds.has(r.ruleId))).toBe(false);
  });

  it("every rule line carries an origin from the vocabulary; a missing one is ai_suggested", () => {
    for (const f of [...two.fields, ...mixed.fields]) for (const r of f.result?.rules ?? []) expect(ORIGINS).toContain(r.origin);
    const raw = clone(FIXTURES.farmTwo) as { fields: Array<{ result: { other_checks: Array<{ origin?: string }> } }> };
    delete raw.fields[0]!.result.other_checks[0]!.origin;
    const a = adaptFarmAnalysis(BackendFarmAnalysis.parse(raw));
    expect(a.fields[0]!.result!.rules[0]!.origin).toBe("ai_suggested");
  });

  it("a blank stays null, a real zero stays zero", () => {
    const raw = clone(FIXTURES.farmTwo) as { fields: Array<{ area_ha: number | null; result: { seasons: Array<{ spring_total_mm: number | null }> } }> };
    raw.fields[0]!.area_ha = null;
    raw.fields[0]!.result.seasons[0]!.spring_total_mm = null;
    raw.fields[0]!.result.seasons[1]!.spring_total_mm = 0;
    const a = adaptFarmAnalysis(BackendFarmAnalysis.parse(raw));
    expect(a.fields[0]!.areaHa).toBeNull();
    expect(a.fields[0]!.result!.springWindow!.years[0]!.total_mm).toBeNull();
    expect(a.fields[0]!.result!.springWindow!.years[1]!.total_mm).toBe(0);
  });
});

describe("profile and research", () => {
  it("keeps AI rows unverified, conflicts and gaps", () => {
    const p = adaptProfile(BackendProfile.parse(FIXTURES.profileArB));
    expect(p.rules.map((r) => r.origin)).toEqual(["source_checked", "ai_suggested"]);
    expect(p.rules[0]!.conflictsWith).toEqual(["ar_b_ai_009"]);
    expect(p.gaps).toHaveLength(1);
    expect(p.crops[0]!.calendar!.origin).toBe("dataset_estimate");
    expect(p.disclaimer).toMatch(/not verified/);
  });
  it("NC rows are verified", () => {
    const p = adaptProfile(BackendProfile.parse(FIXTURES.profileUsNc));
    expect(p.status).toBe("complete");
    expect(p.crops.every((c) => c.calendar?.origin === "verified_source")).toBe(true);
  });
  it("research without a key is unavailable with its sentence", () => {
    const j = adaptResearch(BackendResearch.parse(FIXTURES.researchUnavailable));
    expect(j).toMatchObject({ jobStatus: "failed", status: "unavailable" });
    expect(j.reasonText).toMatch(/not set up/);
  });
});

const farm: Farm = {
  schema: "acre.farm.v1",
  farm_id: "f_test",
  name: "Test farm",
  anchor: { latitude: -33.89, longitude: -60.57 },
  created_at: "2026-11-14T00:00:00Z",
  updated_at: "2026-11-14T00:00:00Z",
  fields: [
    {
      field_id: "a",
      name: "A",
      geometry: POLYGONS.pergamino_square.geometry as Farm["fields"][number]["geometry"],
      plan: {
        plan_id: "a_plan",
        previous_crop_id: "maize",
        next_crop_id: "soybean",
        prev_harvest: "04-20",
        next_plant: "11-15",
        winter: { kind: "cover", crop_id: "cereal_rye", seed: "05-01", terminate: "10-20" },
        origins: { crops: "grower" },
      },
      notes: "private note",
    },
    { field_id: "b", name: "B (no plan yet)", geometry: POLYGONS.pergamino_l.geometry as Farm["fields"][number]["geometry"], plan: null },
  ],
};

describe("farm request", () => {
  it("sends fields with plans, in the backend's shape, and nothing extra", () => {
    const body = toBackendFarm(farm);
    expect(body.farm.fields).toHaveLength(1);
    const f = body.farm.fields[0]!;
    expect(f.plan).toEqual({
      plan_id: "a_plan",
      previous_crop_id: "maize",
      next_crop_id: "soybean",
      prev_harvest: "04-20",
      next_plant: "11-15",
      winter: { kind: "cover", crop_id: "cereal_rye", seed: "05-01", terminate: "10-20" },
      grower: { low_moisture_concern: null },
    });
    expect(JSON.stringify(body)).not.toMatch(/private note/);
    expect(body.options).toEqual({ include_soil: true, prepare_weather: true });
  });
});

describe("global client", () => {
  const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 1000, fetchImpl: fixtureFetch() });

  it("searches, reverses and reads capabilities from the fixtures", async () => {
    const s = await client.geoSearch("Pergamino");
    expect(s.ok && s.data.hits[0]!.label).toBe("Pergamino, Buenos Aires, Argentina");
    const c = await client.geoSearch("35.1, -80.5");
    expect(c.ok && c.data.queryKind).toBe("coordinates");
    const r = await client.geoReverse({ latitude: -33.89, longitude: -60.57 });
    expect(r.ok && r.data.admin1).toBe("AR-B");
    const cap = await client.capabilities({ latitude: 34.98, longitude: -80.55 });
    expect(cap.ok && cap.data.regionKey).toBe("US-NC");
  });

  it("analyzes a farm and keeps the request's own field ids", async () => {
    const a = await client.analyzeFarm(farm);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.data.fields.map((f) => f.fieldId)).toEqual(["a"]);
  });

  it("a 400 comes back as typed issues naming the field", async () => {
    const bad: FetchLike = async () => ({ ok: false, status: 400, text: async () => JSON.stringify(FIXTURES.farmInvalidBowtie) });
    const c = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 1000, fetchImpl: bad });
    const r = await c.analyzeFarm(farm);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("invalid");
      expect(r.issues![0]).toMatchObject({ field: "farm.fields[0].geometry", code: "self_intersection" });
      expect(r.message).toMatch(/Bowtie/);
    }
  });

  it("without a service every call is offline, and nothing is fetched", async () => {
    let calls = 0;
    const c = createGlobalClient({ apiBase: null, timeoutMs: 1000, fetchImpl: async () => (calls++, { ok: true, status: 200, text: async () => "{}" }) });
    const r = await c.geoSearch("Pergamino");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("offline");
    expect(calls).toBe(0);
  });

  it("an unknown profile is not-found, not an empty profile", async () => {
    const r = await client.regionProfile("FR-IDF");
    expect(r.ok).toBe(false);
  });
});
