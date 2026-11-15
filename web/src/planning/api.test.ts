import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFuturePlan, futureResponseSchema, generatePlans, generateResponseSchema, goalsSchema, PlanningApiError, futureRequestSchema, recommendPlans, recommendResponseSchema } from "./api";
import { createGoalsPanelValue } from "./GoalsPanel";
import { candidate, generated, jsonResponse, plans, point, recommendation } from "./test-fixtures";
import realGenerate from "./fixtures/union-generate.json";
import realRecommend from "./fixtures/union-recommend.json";
import realFuture from "./fixtures/union-future.json";
import realEdited from "./fixtures/union-future-edited.json";
afterEach(() => vi.unstubAllGlobals());
describe("planning contracts", () => {
  it("parses backend Union County generation, recommendation, future and edited future responses", () => {
    expect(generateResponseSchema.parse(realGenerate).candidates.length).toBeGreaterThan(0);
    expect(recommendResponseSchema.parse(realRecommend).shortlist.length).toBeGreaterThan(0);
    expect(futureResponseSchema.parse(realFuture).seasons).toHaveLength(2);
    expect(futureResponseSchema.parse(realEdited).diff?.changes.length).toBeGreaterThan(0);
  });
  it("rejects unknown priority names, booleans, out-of-range weights, conflicting constraints and invalid month-days", () => {
    const goals = createGoalsPanelValue().goals;
    for (const priorities of [{
      ...goals.priorities,
      invented: 2
    }, {
      ...goals.priorities,
      soil_cover: false
    }, {
      ...goals.priorities,
      soil_cover: 4
    }]) expect(goalsSchema.safeParse({
      ...goals,
      priorities
    }).success).toBe(false);
    expect(goalsSchema.safeParse({
      ...goals,
      constraints: {
        ...goals.constraints,
        must_include: ["soybean"],
        excluded_crops: ["soybean"]
      }
    }).success).toBe(false);
    expect(goalsSchema.safeParse({
      ...goals,
      constraints: {
        ...goals.constraints,
        latest_planting: "02-31"
      }
    }).success).toBe(false);
  });
  it("posts to all three real endpoints and preserves null and unknown input", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(generated)).mockResolvedValueOnce(jsonResponse(recommendation)).mockResolvedValueOnce(jsonResponse(realFuture));
    vi.stubGlobal("fetch", fetch);
    const goals = createGoalsPanelValue().goals;
    const signal = new AbortController().signal;
    await generatePlans({
      location: point,
      field: {
        soil: null
      },
      goals
    }, signal);
    await recommendPlans({
      location: point,
      goals,
      candidates: [{
        candidate_id: candidate.candidate_id,
        plans
      }]
    }, signal);
    await fetchFuturePlan({
      location: point,
      candidate: generated.candidates[0],
      start_season: "2027",
      seasons: 2
    }, signal);
    expect(fetch.mock.calls.map(c => c[0])).toEqual(["http://localhost:8000/v1/plans/generate", "http://localhost:8000/v1/plans/recommend", "http://localhost:8000/v1/plans/future"]);
    const sent = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(sent.goals.constraints.irrigation).toBe("unknown");
    expect(sent.field.soil).toBeNull();
    expect(fetch.mock.calls[0]![1].signal).toBe(signal);
  });
  it("rejects unreadable and incompatible responses and exposes structured backend issues", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("Bad gateway", {
      status: 502
    })).mockResolvedValueOnce(jsonResponse({
      not_a_result: true
    })).mockResolvedValueOnce(jsonResponse({
      status: "invalid_input",
      issues: [{
        field: "goals.constraints.must_include",
        message: "A crop is required and excluded."
      }]
    }, 400)));
    await expect(recommendPlans({
      location: point
    })).rejects.toBeInstanceOf(PlanningApiError);
    await expect(recommendPlans({
      location: point
    })).rejects.toThrow(/API contract/);
    await expect(recommendPlans({
      location: point
    })).rejects.toThrow(/required and excluded/);
  });
});

describe("future plan length", () => {
  it("accepts up to 10 manual plans and 10 seasons, like the backend, and refuses 11", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...plans[0]!, plan_id: `season_${i + 1}` }));
    const base = { location: point, start_season: "2027" };
    expect(futureRequestSchema.safeParse({ ...base, plans: many(10), seasons: 10 }).success).toBe(true);
    expect(futureRequestSchema.safeParse({ ...base, plans: many(11), seasons: 10 }).success).toBe(false);
    expect(futureRequestSchema.safeParse({ ...base, plans: many(10), seasons: 11 }).success).toBe(false);
  });
});
