import type { Option } from "../../api/model";
import { num } from "./format";

/*
  Step 4's reasons in plain words (card 11). The service says which measure a suggested plan
  comes out best on and gives the measure's value; this file only restates that as one
  sentence with its number. It never ranks or judges: "the fewest of these plans" is said only
  when the service itself named the plan best on that measure.

  Left out on purpose: a "best" that every suggested plan shares (a tie is not a reason), and a
  "highest" whose value is zero.
*/
type Kind = "fewest" | "least" | "most" | "wettest";
interface Wording {
  /** The sentence without its ending, given the formatted value. */
  say: (v: string, raw: number) => string;
  kind: Kind;
}

const days = (v: number) => (v === 1 ? "day" : "days");
const WORDING: Record<string, Wording> = {
  bare_soil_days: { kind: "fewest", say: (v, raw) => `Leaves the ground bare for about ${v} ${days(raw)} a year` },
  rain_on_bare_soil_mm: { kind: "least", say: (v) => `About ${v} of rain a season falls on bare ground` },
  heavy_rain_days_on_bare_soil: { kind: "fewest", say: (v, raw) => (raw === 0 ? "No heavy-rain days on bare ground in a typical season" : `Heavy rain hits bare ground on about ${v} ${days(raw)} a season`) },
  living_cover_days: { kind: "most", say: (v, raw) => `Something is growing on about ${v} ${days(raw)} a year` },
  modeled_root_zone_wetness_at_planting: { kind: "wettest", say: (v) => `Soil at planting time is about ${v} wet in a typical year (NASA's estimate)` },
  management_operations: { kind: "fewest", say: (v, raw) => `Needs about ${v} field ${raw === 1 ? "job" : "jobs"} a season` },
  dry_pre_plant_frequency: { kind: "fewest", say: (v) => `Planting time was too dry in about ${v} of every 10 past seasons` },
  crop_family_diversity: { kind: "most", say: (v, raw) => `Grows ${v} different crop ${raw === 1 ? "family" : "families"}` },
};
const ENDING: Record<Kind, [alone: string, shared: string]> = {
  fewest: ["the fewest of these plans", "as few as any of these plans"],
  least: ["the least of these plans", "as little as any of these plans"],
  most: ["the most of these plans", "as many as any of these plans"],
  wettest: ["the wettest of these plans", "as wet as any of these plans"],
};

function shown(indicator: string, value: number, unit: string | null): string {
  if (indicator === "rain_on_bare_soil_mm") return num(value, "mm");
  if (indicator === "modeled_root_zone_wetness_at_planting") return `${Math.round(value * 100)}%`;
  if (indicator === "dry_pre_plant_frequency") return num(value * 10, null, 0);
  // Whole numbers from ten up ("about 137 days"); one decimal below that ("about 4.5 days").
  return num(value, null, Number.isInteger(value) || Math.abs(value) >= 10 ? 0 : 1) + (unit && !WORDING[indicator] ? ` ${unit}` : "");
}

export interface PlainReason {
  indicator: string;
  text: string;
  /** True when another suggestion in the list does equally well on this measure. */
  shared: boolean;
}

/** The plain reasons for one suggestion, in the service's own order. `all` is the list the suggestion is shown in. */
export function plainReasons(option: Option, all: Option[]): PlainReason[] {
  const out: PlainReason[] = [];
  for (const why of option.why) {
    const ind = option.indicators[why.indicator];
    const wording = WORDING[why.indicator];
    if (!ind || ind.value == null || !wording) continue;
    const others = all.filter((o) => o.candidateId !== option.candidateId).map((o) => o.indicators[why.indicator]?.value);
    // A value every suggestion shares tells the grower nothing about this one.
    if (others.length > 0 && others.every((v) => v === ind.value)) continue;
    if ((wording.kind === "most" || wording.kind === "wettest") && ind.value === 0) continue;
    const shared = others.some((v) => v === ind.value);
    out.push({ indicator: why.indicator, shared, text: `${wording.say(shown(why.indicator, ind.value, ind.unit), ind.value)}, ${ENDING[wording.kind][shared ? 1 : 0]}.` });
  }
  return out;
}

/** One measure of the plan with no claim about the others, for a suggestion the service gave no usable reason for. */
export function plainFact(option: Option): string | null {
  for (const key of ["bare_soil_days", "rain_on_bare_soil_mm", "living_cover_days"]) {
    const ind = option.indicators[key];
    const wording = WORDING[key];
    if (ind?.value == null || !wording || (key === "living_cover_days" && ind.value === 0)) continue;
    return `${wording.say(shown(key, ind.value, ind.unit), ind.value)}.`;
  }
  return null;
}
