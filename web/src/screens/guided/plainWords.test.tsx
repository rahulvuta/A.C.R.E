import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioResult } from "../../api/simModel";
import { resetUnitsForTests } from "../../ui/units";
import { differenceWords, FineRainCard, type FineRainDoc } from "./FineRain";
import { plainFacts } from "./plainWords";

vi.mock("../../config", async (orig) => ({ ...(await orig<typeof import("../../config")>()), API_BASE: "https://service.invalid" }));

const d = (median: number | null, p10: number | null = null, p90: number | null = null, extra: Record<string, unknown> = {}) => ({ median, p10, p90, origin: "calculation", ...extra });
const result = (totals: Record<string, unknown>): ScenarioResult => ({ scenarioId: "current", label: "What I do now", yearly: Array.from({ length: 10 }, () => ({})), totals, moneyGaps: [], timeline: [] }) as unknown as ScenarioResult;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUnitsForTests();
});

describe("the figures sent for the plain-words paragraph (card 26)", () => {
  it("are the exact strings of the three sentences, with no name, place or free text", () => {
    resetUnitsForTests({ rain: "mm" });
    const s = result({
      dry_springs: d(2, 0, 4),
      rain_on_bare_soil_mm_per_year: d(724.9),
      heavy_rain_days_on_bare_soil_per_year: d(4.5),
      margin_10y: d(3315515, 3130832, 3521332, { currency: "KES", includesAssumption: "dry_spring_pct" }),
    });
    const body = plainFacts(s, ["maize", "dry_beans", "Not a crop id!"], false);
    expect(body.facts).toMatchObject({ years: "10", dry_years: "2", dry_low: "0", dry_high: "4", rain_bare: "725 mm", heavy_days: "4.5" });
    expect(body.facts.money_year).toMatch(/^KES.331,552$/);
    expect(body.facts.money_total).toMatch(/^KES.3,315,515$/);
    expect(body.flags).toEqual(["money_uses_loss_estimate"]);
    expect(body.crops).toEqual(["maize", "dry_beans"]); // anything that is not a crop id is left out
    // every value is a figure: digits with an optional currency or unit, nothing else
    for (const v of Object.values(body.facts)) expect(v).toMatch(/^-?(?:[A-Z]{3}\s?|[$€£₹])?-?\d[\d,.\s]*(?:\s?(?:mm|in))?$/u);
    expect(Object.keys(body)).toEqual(["facts", "flags", "crops"]);
  });

  it("says when there is no money, or when money does not move, instead of sending a number", () => {
    const none = plainFacts(result({ dry_springs: d(0), rain_on_bare_soil_mm_per_year: d(93) }), ["rice"], true);
    expect(none.flags).toEqual(["no_money", "two_crops_a_year"]);
    expect(none.facts.money_year).toBeUndefined();
    expect(none.facts.dry_low).toBeUndefined(); // no range was returned, so none is sent
    const flat = plainFacts(result({ margin_10y: d(1000, 1000, 1000, { currency: "INR" }) }), [], false);
    expect(flat.flags).toEqual(["money_flat"]);
    expect(flat.facts.money_low).toBeUndefined();
  });

  it("rain is sent in the grower's own unit, as the sentence above shows it", () => {
    resetUnitsForTests({ rain: "in" });
    expect(plainFacts(result({ rain_on_bare_soil_mm_per_year: d(724.9) }), [], false).facts.rain_bare).toBe("28.5 in");
  });
});

describe("rain closer to the field (card 30)", () => {
  const doc: FineRainDoc = {
    status: "complete",
    years: [{ year: 2023, fine_mm: 1500, coarse_mm: 1900 }, { year: 2024, fine_mm: 1584, coarse_mm: 2917 }, { year: 2025, fine_mm: 1911, coarse_mm: 2185 }],
    summary: { years: 28, first_year: 1998, last_year: 2025, fine_mean_mm: 1434, coarse_mean_mm: 1868, difference_pct: -23, years_fine_lower: 26 },
  };

  it("puts the two records side by side, says the difference in words and that no result changes", () => {
    resetUnitsForTests({ rain: "mm" });
    render(<FineRainCard doc={doc} />);
    const card = screen.getByRole("region", { name: "Rain closer to your field" });
    expect(card).toHaveTextContent("1,434 mm a year");
    expect(card).toHaveTextContent("1,868 mm a year");
    expect(card).toHaveTextContent("Over 1998 to 2025, the 10 km record is about 23% drier than the 50 km record (lower in 26 of 28 years).");
    expect(card).toHaveTextContent("this changes no result");
    expect(card).toHaveTextContent("NASA measured");
    expect(card).toHaveTextContent("NASA model");
    expect(screen.getByRole("img", { name: /Rain each year from 2023 to 2025/ })).toBeInTheDocument();
    // every yearly value is in the table, in the grower's unit
    expect(card.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(card).toHaveTextContent("2,917 mm");
  });

  it("words the difference plainly and shows only the fine record when the other is missing", async () => {
    render(<FineRainCard doc={{ ...doc, summary: { ...doc.summary!, coarse_mean_mm: 1300, difference_pct: 7, years_fine_lower: 1, years: 27 } }} />);
    expect(screen.getByRole("region", { name: "Rain closer to your field" })).toHaveTextContent("about 7% wetter than the 50 km record (higher in 26 of 27 years).");
    cleanup();
    expect(differenceWords(-23)).toBe("about 23% drier");
    expect(differenceWords(14)).toBe("about 14% wetter");
    expect(differenceWords(3)).toBe("about the same");
    expect(differenceWords(null)).toBeNull();
    render(<FineRainCard doc={{ status: "partial", reason_text: "The 50 km record for this field is not stored yet.", years: [{ year: 2025, fine_mm: 1911, coarse_mm: null }], summary: { years: 20, first_year: 2006, last_year: 2025, fine_mean_mm: 1400, coarse_mean_mm: null, difference_pct: null, years_fine_lower: null } }} />);
    const card = screen.getByRole("region", { name: "Rain closer to your field" });
    expect(card).toHaveTextContent("The 50 km record for this field is not stored yet.");
    expect(card).not.toHaveTextContent("drier");
    await waitFor(() => expect(card.querySelectorAll(".fr-pair > div")).toHaveLength(1));
    cleanup();
    const { container } = render(<FineRainCard doc={{ status: "unavailable", years: [], summary: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("results for a crop that stays in the ground (card 21)", () => {
  const covered = { ...result({ dry_springs: d(0), rain_on_bare_soil_mm_per_year: d(0), margin_10y: d(130000, 130000, 130000, { currency: "USD" }) }), timeline: [{ year: 2027, season: "2027", cropSequence: ["coffee"], planId: "season_1", ground: "permanent" }] } as unknown as ScenarioResult;

  it("says the ground is covered instead of reporting two zeros as weather news", async () => {
    const { plainSentences } = await import("./PlainAnswer");
    const rows = plainSentences(covered);
    expect(rows.map((r) => r.key)).toEqual(["rain", "money"]);
    expect(rows[0]!.text).toBe("The ground stays covered all year, so no rain falls on bare ground and there is no planting time to check.");
    const body = plainFacts(covered, ["coffee"]);
    expect(body.flags).toContain("ground_covered_all_year");
    expect(body.facts.dry_years).toBeUndefined();
    expect(body.facts.rain_bare).toBeUndefined();
    expect(body.facts.money_year).toBeDefined();
  });

  it("says nothing is sold from grazed land, without asking for prices", async () => {
    const { plainSentences } = await import("./PlainAnswer");
    const grazed = { ...covered, totals: { dry_springs: d(0), rain_on_bare_soil_mm_per_year: d(0) }, moneyStatus: "unavailable", moneyGaps: ["Nothing is sold from this field in the plan, so there is no money result."], nothingSold: true } as unknown as ScenarioResult;
    const money = plainSentences(grazed).find((r) => r.key === "money")!;
    expect(money.text).toBe("Nothing is sold from this field in the plan, so there is no money result.");
    expect(money.missing).toBeUndefined(); // so no "Add prices and costs" button follows it
    const flags = plainFacts(grazed, ["pasture"]).flags;
    expect(flags).toContain("nothing_sold");
    expect(flags).not.toContain("no_money");
  });

  it("tells the model when a crop is grown together with the main one", () => {
    const mixed = { ...result({ dry_springs: d(1) }), timeline: [{ year: 2027, season: "2027", cropSequence: ["maize"], planId: "season_1", companions: ["dry_beans"], ground: "yearly" }] } as unknown as ScenarioResult;
    expect(plainFacts(mixed, ["maize", "dry_beans"]).flags).toContain("crops_grown_together");
  });
});
