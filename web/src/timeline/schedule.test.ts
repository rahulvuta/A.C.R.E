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
});
