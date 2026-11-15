import { afterEach, describe, expect, it, vi } from "vitest";
import { createInputsApi } from "./api";
import { exampleAutofill, exampleEconomics, exampleEquipment, exampleLocation, exampleResearchPending, exampleResearchReady, exampleSearch } from "./examples";
import { autofillResponseSchema, economicsResponseSchema, monthDaySchema, readingSchema, researchJobSchema } from "./schema";

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("input API contracts", () => {
  it("uses the contract paths, encodes names, sends only name and region to AI, and forwards cancellation", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(exampleSearch)).mockResolvedValueOnce(json(exampleResearchPending)).mockResolvedValueOnce(json(exampleResearchReady)).mockResolvedValueOnce(json(exampleAutofill)).mockResolvedValueOnce(json(exampleEconomics)).mockResolvedValueOnce(json(exampleEquipment));
    vi.stubGlobal("fetch", fetch);
    const api = createInputsApi("https://example.invalid/");
    const signal = new AbortController().signal;
    await api.search("corn & rye", "US-NC", signal);
    await api.research("okra", "US-NC", signal);
    await api.researchJob("job/with space", signal);
    await api.autofill({ location: exampleLocation, crops: [{ role: "next", crop_id: "soybean" }] }, signal);
    await api.estimate({ location: exampleLocation, crops: ["soybean"], area: { value: null, unit: "ha" }, equipment: [], overrides: {} }, signal);
    await api.equipment(signal);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "https://example.invalid/v1/crops/search?q=corn+%26+rye&region_key=US-NC", "https://example.invalid/v1/crops/research", "https://example.invalid/v1/crops/research/job%2Fwith%20space", "https://example.invalid/v1/plans/autofill", "https://example.invalid/v1/economics/estimate", "https://example.invalid/v1/vocab/equipment",
    ]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ name: "okra", region_key: "US-NC" });
    expect(JSON.parse(fetch.mock.calls[4]![1].body).area).toBeNull();
    for (const call of fetch.mock.calls) expect(call[1].signal).toBe(signal);
  });
  it("rejects malformed responses and reports backend issues without substituting examples", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("Bad gateway", { status: 502 })).mockResolvedValueOnce(json({ results: [] })).mockResolvedValueOnce(json({ issues: [{ field: "crops", message: "Choose a crop." }] }, 400)));
    const api = createInputsApi();
    await expect(api.search("", "US-NC")).rejects.toThrow(/unreadable/);
    await expect(api.search("", "US-NC")).rejects.toThrow(/API contract/);
    await expect(api.search("", "US-NC")).rejects.toThrow("crops: Choose a crop.");
  });
  it("accepts unavailable money and date references without making up values", () => {
    const result = economicsResponseSchema.parse({ meta: {}, currency: null, area_unit: "ha", crops: [{ crop_id: "okra", price: null, yield: null, costs: { items: [], total_per_area: null }, status: "unavailable", reason_text: "No regional references." }], equipment_costs: [], gaps: [] });
    expect(result.crops[0]?.price).toBeNull();
    expect(autofillResponseSchema.parse({ meta: {}, plan: null, dates: [{ field: "next_plant", value: null, origin: null }], gaps: [{ field: "next_plant", text: "No local date available." }] }).gaps).toEqual(["No local date available."]);
  });
  it("keeps VWC and reading depth without accepting impossible sensor values", () => {
    expect(readingSchema.parse({ date: "2026-04-02", kind: "soil_moisture_vwc", value: 0, depth_cm: 10, origin: "grower" }).depth_cm).toBe(10);
    for (const reading of [{ kind: "soil_moisture_vwc", value: 1.1 }, { kind: "soil_temp_c", value: 61 }, { kind: "rainfall_mm", value: 1001 }, { kind: "note", value: 0, note: "Observation" }]) expect(readingSchema.safeParse({ date: "2026-04-02", origin: "grower", ...reading }).success).toBe(false);
  });
  it("rejects verified AI results, invalid month-days and invalid readings, and preserves a genuine zero", () => {
    expect(researchJobSchema.safeParse({ ...exampleResearchReady, crop: { ...exampleResearchReady.crop, origin: "verified_source" } }).success).toBe(false);
    expect(monthDaySchema.safeParse("02-31").success).toBe(false);
    expect(monthDaySchema.safeParse("02-29").success).toBe(true);
    expect(readingSchema.safeParse({ date: "2026-02-29", kind: "rainfall_mm", value: 1, origin: "grower" }).success).toBe(false);
    expect(readingSchema.safeParse({ date: "2026-04-02", kind: "soil_moisture_pct", value: 101, origin: "grower" }).success).toBe(false);
    expect(readingSchema.parse({ date: "2026-04-02", kind: "rainfall_mm", value: 0, origin: "grower" }).value).toBe(0);
  });
});
