import { describe, expect, it } from "vitest";
import { adaptVocab, BackendVocab, toBackendGoals } from "./adapt";
import { createGlobalClient } from "./client";
import { FIXTURE_API_BASE, fixtureFetch } from "./fixtures";

const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 2000, fetchImpl: fixtureFetch() });
const place = { point: { latitude: 34.98, longitude: -80.55 } };

describe("planning endpoints (§8–§10)", () => {
  it("generate returns candidates with seasons and origins", async () => {
    const r = await client.generate(place, { priorities: { soil_cover: 3 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.candidates.length).toBeGreaterThan(0);
    expect(r.data.candidates[0]!.seasons.length).toBeGreaterThan(0);
    expect(r.data.log.every((l) => typeof l.reasonText === "string")).toBe(true);
  });

  it("recommend returns a shortlist with no composite score field", async () => {
    const r = await client.recommend(place, { priorities: { soil_cover: 3 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.shortlist.length).toBeGreaterThan(0);
    const o = r.data.shortlist[0]!;
    expect(Object.keys(o)).not.toContain("score");
    expect(Object.values(o.indicators).every((i) => i.origin)).toBe(true);
  });

  it("future returns seasons with windows, milestones and deadlines", async () => {
    const r = await client.future(place, { candidate: {} }, "2027", 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.data.seasons[0]!;
    expect(s.windows.length).toBeGreaterThan(0);
    expect(s.deadlines.length).toBeGreaterThan(0);
    expect(r.data.note).toMatch(/cannot say what the weather/i);
  });

  it("sends available equipment in field context, separate from equipment limitations", async () => {
    let body: Record<string, any> = {};
    const fixture = fixtureFetch();
    const capture = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 2000, fetchImpl: (url, init) => {
      body = JSON.parse(init?.body ?? "{}");
      return fixture(url, init);
    } });
    const equipment = ["planter", "grain_drill", "sprayer", "combine"];
    const response = await capture.recommend(place, { priorities: { soil_cover: 3 } }, { fieldId: "synthetic", areaHa: 16.2, cropHistory: [], equipment });
    expect(response.ok).toBe(true);
    expect(body.field.equipment).toEqual(equipment);
    expect(body.goals.constraints.equipment).toEqual([]);
  });
  it("uses the published priority_id vocabulary key for labels and explanations", () => {
    expect(adaptVocab(BackendVocab.parse({ priorities: [{ priority_id: "profit", label: "Margin", explanation: "Margin from your numbers or sourced references." }] }))).toEqual([{ id: "profit", label: "Margin", explanation: "Margin from your numbers or sourced references." }]);
  });
  it("unknown irrigation stays unknown, never false", () => {
    const b = toBackendGoals({ priorities: { soil_cover: 2 } });
    expect(b.constraints.irrigation).toBe("unknown");
    expect(b.constraints).not.toHaveProperty("seasons");
  });
});
