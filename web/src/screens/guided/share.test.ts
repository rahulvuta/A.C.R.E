import { describe, expect, it } from "vitest";
import type { FieldPlan } from "../../farm/types";
import { buildShare, shareText, type ShareInput } from "./share";
import { textOf } from "./SharePlan";

const plan: FieldPlan = { plan_id: "season_1", label: "Season 1", previous_crop_id: "maize", prev_harvest: "08-31", winter: { kind: "winter_grain", crop_id: "dry_beans", plant: "10-15", harvest: "01-15" }, next_crop_id: "maize", next_plant: "03-15", origins: { dates: "grower" } };
const input: ShareInput = {
  fieldName: "Shamba ya juu",
  size: "3.4 ha",
  planLine: "Every year: maize, then dry beans as a second crop.",
  jobs: [{ date: "2027-03-15", label: "Plant maize" }, { date: "2027-08-31", label: "Harvest maize" }],
  sentences: ["In a typical run, the weeks before planting were too dry in 2 of the 10 years.", "About 341 mm of rain a year falls while the ground is bare.", "After the costs in your plan, it leaves about KES 236,470 a year for the whole field (KES 2,364,700 over 10 years)."],
  rotation: [plan],
  overrides: { maize: { price: { value: 35000, unit: "KES/t" } }, dry_beans: { price: { value: 100000, unit: "KES/t" } } },
  crops: ["maize", "dry_beans"],
  sourceYears: "1981-2025",
  runs: 200,
  cautions: [],
  today: "2026-11-16",
};

describe("sharing a plan (card 22)", () => {
  it("carries the plan in one line, this season's jobs, the three sentences and where the numbers came from", () => {
    const s = buildShare(input);
    expect(s.title).toBe("10-year plan for Shamba ya juu (3.4 ha)");
    expect(s.jobs).toEqual(["Plant maize around 15 March 2027", "Harvest maize around 31 August 2027"]);
    expect(s.sentences).toEqual(input.sentences);
    expect(s.sources.join(" ")).toMatch(/NASA records for 1981-2025/);
    expect(s.sources).toContain("Prices, yields and costs: the grower's own numbers.");
    expect(s.sources).toContain("Planting and harvest dates: the grower's own.");
    expect(s.foot.join(" ")).toMatch(/local farm adviser or co-op/);
  });

  it("says when the money rests on published figures or on typical dates, not the grower's", () => {
    const s = buildShare({ ...input, overrides: { maize: { price: { value: 35000, unit: "KES/t" } } }, rotation: [{ ...plan, origins: { dates: "dataset_estimate" } }] });
    expect(s.sources).toContain("Prices, yields and costs: the grower's own numbers for some crops, published figures for the rest.");
    expect(s.sources.join(" ")).toMatch(/typical dates for the area/);
    expect(buildShare({ ...input, overrides: {} }).sources).toContain("Prices, yields and costs: published figures for the area, not the grower's own.");
  });

  it("the text version is plain lines that paste into a chat, and holds nothing that locates the field", () => {
    const text = shareText(buildShare({ ...input, cautions: ["A crop grown together with the main crop is not counted, so the money is less than you really earn."] }));
    expect(text.split("\n").slice(0, 2)).toEqual(["10-year plan for Shamba ya juu (3.4 ha)", "Every year: maize, then dry beans as a second crop."]);
    expect(text).toContain("This season\n1. Plant maize around 15 March 2027\n2. Harvest maize around 31 August 2027");
    expect(text).toContain("Not in these results\n- A crop grown together");
    expect(text).not.toMatch(/[<>|*#_`]/); // no markup or table characters
    // No coordinates: nothing shaped like a latitude or longitude, and no geometry words.
    expect(text).not.toMatch(/-?\d{1,3}\.\d{3,}/);
    expect(text).not.toMatch(/latitude|longitude|coordinates|geometry/i);
    expect(text.length).toBeLessThan(1500);
  });

  it("the message copied from the screen matches the text version", () => {
    const s = buildShare(input);
    const root = document.createElement("div");
    root.innerHTML = `<h2 class="sp-title">${s.title}</h2><p class="sp-plan">${s.planLine}</p><section><h3>This season</h3><ol>${s.jobs.map((j) => `<li>${j}</li>`).join("")}</ol></section><section><h3>What the past weather says</h3><ul>${s.sentences.map((j) => `<li>${j}</li>`).join("")}</ul></section><section><h3>Where the numbers come from</h3><ul>${s.sources.map((j) => `<li>${j}</li>`).join("")}</ul></section><footer>${s.foot.map((j) => `<p>${j}</p>`).join("")}</footer>`;
    expect(textOf(root)).toBe(shareText(s));
  });
});
