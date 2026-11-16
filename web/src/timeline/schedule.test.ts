import { describe, expect, it } from "vitest";
import request from "./fixtures/simulate-union.request.json";
import response from "./fixtures/simulate-union.json";
import { buildRows, formatMd } from "./schedule";
import type { FieldPlan } from "../farm/types";
import type { TimelineEntry } from "./types";

const rot = (id: string) => (request.scenarios.find((s) => s.scenario_id === id)!.rotation as unknown as FieldPlan[]);
const tl = (id: string) => response.scenarios.find((s) => s.scenario_id === id)!.timeline as TimelineEntry[];

describe("buildRows", () => {
  it("one row per year, bands cover the whole year without overlap", () => {
    const rows = buildRows(tl("s2"), rot("s2"));
    expect(rows.map((r) => r.year)).toEqual([2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035, 2036]);
    for (const r of rows) {
      expect(r.datesKnown).toBe(true);
      expect(r.bands[0]!.from).toBe(0);
      expect(r.bands[r.bands.length - 1]!.to).toBe(1);
      for (let i = 1; i < r.bands.length; i++) expect(r.bands[i]!.from).toBeCloseTo(r.bands[i - 1]!.to, 9);
    }
  });

  it("2027 with rye: rye until Apr 30, bare until soybean planted May 12, harvested Oct 25, clover seeded Oct 30", () => {
    const r = buildRows(tl("s2"), rot("s2"))[0]!;
    const seq = r.bands.map((b) => `${b.kind}:${b.crop ?? "-"}:${b.startDate ?? ""}-${b.endDate ?? ""}`);
    expect(seq).toEqual(["cover:cereal_rye:-04-30", "fallow:-:04-30-05-12", "cash:soybean:05-12-10-25", "fallow:-:10-25-10-30", "cover:crimson_clover:10-30-"]);
    expect(r.mainCrops).toEqual(["soybean"]);
    expect(r.bands[2]!.startMark).toBe("plant");
    expect(r.bands[2]!.endMark).toBe("harvest");
  });

  it("wheat then double-crop soybean are both cash crops in one year", () => {
    const r = buildRows(tl("s3"), rot("s3"))[0]!;
    expect(r.bands.filter((b) => b.kind === "cash").map((b) => b.crop)).toEqual(["wheat", "soybean"]);
  });

  it("the last year is complete: the rotation goes on after it (harvest, then the next winter)", () => {
    const rows = buildRows(tl("s2"), rot("s2"));
    const last = rows[rows.length - 1]!;
    expect(last.bands.some((b) => b.kind === "cash" && b.endMark === "harvest")).toBe(true);
    expect(last.bands[last.bands.length - 1]!.kind).toBe("cover");
  });

  it("without dates, crops are shown in order and the row says dates are not set", () => {
    const rows = buildRows(tl("s2"));
    expect(rows[0]!.datesKnown).toBe(false);
    expect(rows[0]!.bands.map((b) => [b.kind, b.crop])).toEqual([["cash", "field_corn"], ["cover", "cereal_rye"], ["cash", "soybean"]]);
  });

  it("a single plan that does not cycle ends with its new crop growing, no invented harvest", () => {
    const plan = rot("current")[0]!; // corn → bare winter → soybean
    const r = buildRows([{ year: 2027, season: "2027", crop_sequence: [], plan_id: plan.plan_id }], [plan])[0]!;
    expect(r.bands.map((b) => [b.kind, b.crop])).toEqual([["fallow", null], ["cash", "soybean"]]);
    expect(r.bands[1]!.endMark).toBeNull();
  });

  it("formats month-days", () => {
    expect(formatMd("05-12")).toBe("May 12");
    expect(formatMd(null)).toBe("");
  });
  it("names a crop grown together with the year's crop, and fills the year for a crop that stays in the ground (card 21)", () => {
    const yearly = { plan_id: "a", label: "A", previous_crop_id: "dry_beans", prev_harvest: "07-15", winter: { kind: "none" as const }, next_crop_id: "maize", next_plant: "03-31" };
    const mixed = buildRows([{ year: 2027, season: "2027", crop_sequence: ["dry_beans", "maize"], plan_id: "a", companions: ["dry_beans"], ground: "yearly" }], [yearly]);
    expect(mixed[0]!.mainCrops).toEqual(["maize", "dry_beans"]);
    const coffee = { plan_id: "a", label: "A", previous_crop_id: "coffee", prev_harvest: "11-15", winter: { kind: "none" as const }, next_crop_id: "coffee", next_plant: "11-15", permanent: { sold: true } };
    const perm = buildRows([{ year: 2027, season: "2027", crop_sequence: ["coffee"], plan_id: "a", ground: "permanent" }], [coffee]);
    expect(perm[0]!.mainCrops).toEqual(["coffee"]);
    expect(perm[0]!.lasting).toBe(true);
    expect(perm[0]!.bands).toEqual([{ kind: "cash", crop: "coffee", from: 0, to: 1, startMark: null, endMark: null, startDate: null, endDate: "11-15" }]);
    const grazed = buildRows([{ year: 2027, season: "2027", crop_sequence: ["pasture"], plan_id: "a", ground: "permanent" }], [{ ...coffee, previous_crop_id: "pasture", next_crop_id: "pasture", prev_harvest: "12-31", next_plant: "12-31", permanent: { sold: false } }]);
    expect(grazed[0]!.bands[0]).toMatchObject({ crop: "pasture", from: 0, to: 1, endDate: null });
  });
});
