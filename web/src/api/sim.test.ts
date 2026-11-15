import { describe, expect, it } from "vitest";
import { adaptDemo, adaptEconomics, adaptSimulation, BackendDemo, BackendEconomics, BackendSimulation, toBackendEconomics, toBackendSimulate } from "./adapt";
import { createGlobalClient } from "./client";
import { FIXTURE_API_BASE, FIXTURES, fixtureFetch } from "./fixtures";
import type { Dist, Scenario } from "./simModel";

const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 2000, fetchImpl: fixtureFetch() });
const plan = { plan_id: "p1", previous_crop_id: "field_corn", prev_harvest: "09-20", winter: { kind: "none" as const }, next_crop_id: "soybean", next_plant: "05-10" };
const scen = (id: string, isBaseline = false): Scenario => ({ scenarioId: id, label: id, isBaseline, rotation: [plan], from: isBaseline ? "current" : "custom" });
const req = (scenarios: Scenario[]) => ({
  point: { latitude: 34.98, longitude: -80.55 },
  field: { fieldId: "f1", name: "North", areaHa: 16.2, equipment: ["planter"], readings: [{ date: "2026-04-02", kind: "soil_moisture_pct" as const, value: 23.5, depthCm: 10 }] },
  priorities: { profit: 3 },
  overrides: { soybean: { price: { value: 11.2, unit: "USD/bu" } } },
  loss: { drySpringPct: 15, wetSpringPct: null, heavyRainPct: null },
  scenarios,
  startSeason: "2027",
});

describe("§11 simulate", () => {
  it("builds the backend body with the baseline flag, readings and the farmer's loss estimate", () => {
    const b = toBackendSimulate({ ...req([scen("current", true), scen("s2")]), loss: { drySpringPct: 15, wetSpringPct: 99, heavyRainPct: null } });
    expect(b.scenarios[0]).toMatchObject({ scenario_id: "current", is_baseline: true, rotation: [{ plan_id: "p1" }] });
    expect(b.scenarios[1]).not.toHaveProperty("is_baseline");
    expect(b.economics.loss_assumptions).toEqual({ dry_spring_pct: 15, heavy_rain_pct: null });
    expect(b.economics.loss_assumptions).not.toHaveProperty("wet_spring_pct");
    expect(b.field.readings[0]).toEqual({ date: "2026-04-02", kind: "soil_moisture_pct", value: 23.5, depth_cm: 10 });
    expect(b).toMatchObject({ years: 10, runs: 200, seed: 7 });
  });

  it("sends total cost overrides using the request shape, preserving zero", () => {
    const q = { ...req([scen("current", true)]), overrides: { soybean: { costPerArea: { value: 0, unit: "USD/acre" } } } };
    expect(toBackendSimulate(q).economics.overrides.soybean).toEqual({ costs: { total: { value: 0, unit: "USD/acre" } } });
    const economics = toBackendEconomics({ point: q.point, crops: ["soybean"], area: { value: null, unit: "ha" }, equipment: [], overrides: q.overrides });
    expect(economics).not.toHaveProperty("area");
    expect(economics.overrides.soybean).toEqual({ costs: { total: { value: 0, unit: "USD/acre" } } });
  });

  it("marks a value that folds in the loss assumption as assumed, and keeps blanks null", () => {
    const s = adaptSimulation(BackendSimulation.parse(FIXTURES.simulateUnion));
    const y = s.scenarios[0]!.yearly[0]!;
    expect(y.money?.margin?.origin).toBe("assumed");
    expect(y.money?.revenue?.p10).toBeNull();
    expect(y.money?.costs?.origin).toBe("calculation");
    expect((s.scenarios[0]!.totals.margin_10y as Dist).includesAssumption).toBe("dry_spring_pct");
  });

  it("always carries the outlook note and the comparison caveat", () => {
    const raw = JSON.parse(JSON.stringify(FIXTURES.simulateUnion));
    delete raw.method.note;
    delete raw.comparison.caveat;
    const s = adaptSimulation(BackendSimulation.parse(raw));
    expect(s.method.note).toMatch(/evidence-based outlook/);
    expect(s.method.note).not.toMatch(/forecast/i);
    expect(s.comparison?.caveat).toMatch(/The stronger of the plans you compared/);
  });

  it("preserves backend money metadata without reading it as a numeric total", () => {
    const raw = structuredClone(FIXTURES.simulateUnion) as Record<string, any>;
    raw.scenarios[0].totals.weather_link = "none: money and weather are separate";
    raw.scenarios[0].totals.crop_families_detail = { field_corn: "Poaceae", soybean: "Fabaceae" };
    raw.scenarios[0].totals.margin_10y_price_cases = { low: 100, typical: 200, high: 300, currency: "USD" };
    const result = adaptSimulation(BackendSimulation.parse(raw));
    expect(result.scenarios[0]!.totals.weather_link).toBeUndefined();
    expect(result.scenarios[0]!.totals.crop_families_detail).toBeUndefined();
    expect((result.raw.scenarios as Array<{ totals: { weather_link: string } }>)[0]!.totals.weather_link).toMatch(/money and weather/);
  });

  it("fixture mode answers with the request's own scenarios; a baseline-only run has no badges", async () => {
    const one = await client.simulate(req([scen("current", true)]));
    expect(one.ok && one.data.scenarios.map((x) => x.scenarioId)).toEqual(["current"]);
    expect(one.ok && one.data.comparison?.badges).toEqual([]);
    const two = await client.simulate(req([scen("base", true), scen("mine")]));
    if (!two.ok) throw new Error(two.message);
    expect(two.data.comparison?.badges.every((b) => ["base", "mine"].includes(b.scenarioId))).toBe(true);
    expect(two.data.comparison?.deltas[0]).toMatchObject({ scenarioId: "mine", versus: "base" });
  });
});

describe("§12 §13 §15 §16", () => {
  it("economics: a crop with no money source stays blank with its reason", () => {
    const e = adaptEconomics(BackendEconomics.parse(FIXTURES.economicsUnion));
    const rye = e.crops.find((c) => c.cropId === "cereal_rye")!;
    expect(rye.status).toBe("unavailable");
    expect(rye.price).toBeNull();
    expect(rye.reasonText).toBeTruthy();
    expect(e.crops.find((c) => c.cropId === "soybean")!.price?.source?.years).toBe("2021-2025");
  });

  it("demo farm: a farm with fields, rotations, equipment and readings", async () => {
    const r = await client.demoFarm("union");
    if (!r.ok) throw new Error(r.message);
    const d = r.data;
    expect(d.label).toMatch(/example values/);
    expect(d.farm.fields).toHaveLength(2);
    const north = d.farm.fields[0]!;
    expect(d.fields[north.field_id]!.rotation).toHaveLength(2);
    expect(north.plan?.plan_id).toBe(d.fields[north.field_id]!.rotation[0]!.plan_id);
    expect(d.fields[north.field_id]!.equipment).toContain("planter");
    expect(north.equipment).toEqual(d.fields[north.field_id]!.equipment);
    expect(north.readings?.[0]).toMatchObject({ date: d.fields[north.field_id]!.readings[0]!.date, kind: d.fields[north.field_id]!.readings[0]!.kind, value: d.fields[north.field_id]!.readings[0]!.value });
    expect(d.lossAssumptions).toEqual({ drySpringPct: 15, wetSpringPct: null, heavyRainPct: null });
    expect(d.overrides.soybean?.price).toEqual({ value: 11.2, unit: "USD/bu" });
    const p = await client.demoFarm("pergamino");
    expect(p.ok && p.data.farm.anchor.latitude).toBeLessThan(0);
  });

  it.each([
    { value: 410, unit: "USD/acre" },
    { total: { value: 410, unit: "USD/acre" } },
    { total_per_area: { value: 410, unit: "USD/acre" } },
  ])("keeps demo costs from supported input and saved response shapes", (costs) => {
    const raw = { ...FIXTURES.demoUnion, economics_overrides: { soybean: { costs } } };
    const demo = adaptDemo(BackendDemo.parse(raw));
    expect(demo.overrides.soybean?.costPerArea).toEqual({ value: 410, unit: "USD/acre" });
  });

  it("autofill, crop search, research job and vocabularies", async () => {
    const a = await client.autofill({ latitude: 34.98, longitude: -80.55 }, [{ role: "previous", cropId: "field_corn" }, { role: "next", cropId: "soybean" }]);
    expect(a.ok && a.data.plan?.winter.kind).toBe("cover");
    expect(a.ok && a.data.dates.every((d) => d.origin)).toBe(true);
    const c = await client.searchCrops("rye", "US-NC");
    expect(c.ok && c.data.results.map((x) => x.cropId)).toEqual(["cereal_rye"]);
    const j = await client.researchCrop("okra", "US-NC");
    expect(j.ok && j.data.jobStatus).toBe("pending");
    const v = await client.vocab("priorities");
    expect(v.ok && v.data.find((x) => x.id === "profit")?.explanation).toBeTruthy();
  });
});
