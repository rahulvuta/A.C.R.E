import { describe, expect, it } from "vitest";
import type { Indicator, Option } from "../../api/model";
import { resetUnitsForTests } from "../../ui/units";
import { plainFact, plainReasons } from "./reasons";

const ind = (name: string, value: number | null, unit: string): Indicator => ({ name, value, unit, direction: "lower_better", origin: "calculation", status: "complete", definition: null, rationale: null, source: null, perLeg: [], inPriorities: true });
const option = (id: string, values: Record<string, [number | null, string]>, why: string[]): Option => ({
  candidateId: id,
  label: id,
  origin: "generated",
  plans: [],
  legStatus: [],
  indicators: Object.fromEntries(Object.entries(values).map(([k, [v, u]]) => [k, ind(k, v, u)])),
  rankPositions: {},
  wins: [],
  loses: [],
  // The service's own sentence, with the wording a grower should never see.
  why: why.map((indicator) => ({ indicator, text: `Highest ${indicator} of the compared plans: 0.00 fraction (0-1) (others: 0.00, modeled)`, source: null })),
  tradeOffs: [],
  uncertainties: [],
  vulnerabilities: [],
  dominatedBy: [],
  missing: [],
});

describe("step 4 reasons in plain words (card 11)", () => {
  const a = option("a", { bare_soil_days: [14, "days per year"], rain_on_bare_soil_mm: [40.6, "mm per season"], living_cover_days: [0, "days per year"], modeled_root_zone_wetness_at_planting: [0.7883, "fraction (0-1)"], heavy_rain_days_on_bare_soil: [0, "days per season"] }, ["living_cover_days", "bare_soil_days", "modeled_root_zone_wetness_at_planting", "heavy_rain_days_on_bare_soil"]);
  const b = option("b", { bare_soil_days: [19, "days per year"], rain_on_bare_soil_mm: [37.8, "mm per season"], living_cover_days: [0, "days per year"], modeled_root_zone_wetness_at_planting: [0.7883, "fraction (0-1)"], heavy_rain_days_on_bare_soil: [0, "days per season"] }, ["rain_on_bare_soil_mm", "modeled_root_zone_wetness_at_planting"]);
  const c = option("c", { bare_soil_days: [31, "days per year"], rain_on_bare_soil_mm: [59.4, "mm per season"], living_cover_days: [0, "days per year"], modeled_root_zone_wetness_at_planting: [0.75, "fraction (0-1)"], heavy_rain_days_on_bare_soil: [0, "days per season"] }, []);
  const all = [a, b, c];

  it("says one plain sentence with its number, and only where the service named the plan best", () => {
    expect(plainReasons(a, all).map((r) => r.shared)).toEqual([false, true]);
    expect(plainReasons(a, all).map((r) => r.text)).toEqual(["Leaves the ground bare for about 14 days a year, the fewest of these plans.", "Soil at planting time is about 79% wet in a typical year (NASA's estimate), as wet as any of these plans."]);
    expect(plainReasons(b, all)[0]!.text).toBe("About 38 mm of rain a season falls on bare ground, the least of these plans.");
  });

  it("never shows the service's raw wording, a tie every plan shares, or a zero", () => {
    for (const o of all)
      for (const r of plainReasons(o, all)) {
        expect(r.text).not.toMatch(/modeled|fraction|0\.00/);
        expect(r.indicator).not.toBe("living_cover_days");
        expect(r.indicator).not.toBe("heavy_rain_days_on_bare_soil");
      }
  });

  it("gives one fact with no claim about the others when the service gave no reason", () => {
    expect(plainReasons(c, all)).toEqual([]);
    expect(plainFact(c)).toBe("Leaves the ground bare for about 31 days a year.");
  });

  it("writes rain in inches for a grower who uses inches", () => {
    resetUnitsForTests({ area: "ac", rain: "in", temp: "F" });
    expect(plainReasons(b, all)[0]!.text).toBe("About 1.5 in of rain a season falls on bare ground, the least of these plans.");
  });
});
