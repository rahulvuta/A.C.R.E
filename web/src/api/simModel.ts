import type { Farm, FieldPlan } from "../farm/types";
import type { Origin, SourceRef, Status, JobStatus } from "./model";

/*
  The model the Scenario Simulator screens read (docs/global/contract.md §11–§16).
  adapt.ts builds these from the backend's responses; nothing here knows a backend field
  name, and nothing here is computed in the browser. Missing values stay `null`.
*/

/** A distribution over the simulated years (p10, median, p90); any part can be blank. */
export interface Dist {
  p10: number | null;
  median: number | null;
  p90: number | null;
  unit: string | null;
  currency: string | null;
  origin: Origin;
  /** The farmer's loss assumption folded into this value, if any (always shown as `assumed`). */
  includesAssumption: string | null;
}

export interface Odds {
  probability: number | null;
  origin: Origin;
}

export interface YearResult {
  year: number;
  indicators: Record<string, Dist | Odds>;
  money: { revenue: Dist | null; costs: Dist | null; margin: Dist | null } | null;
}

export interface ScenarioEvent {
  event: string;
  probability: number | null;
  text: string;
}

export interface ReadingContext {
  date: string;
  kind: string;
  value: number | null;
  origin: Origin;
  /** What NASA modeled for the same day, shown beside the reading, never merged with it. */
  modeled: Array<{ name: string; value: number | null; origin: Origin }>;
}

export interface ScenarioResult {
  scenarioId: string;
  label: string;
  status: Status;
  reasonText: string | null;
  timeline: Array<{ year: number; season: string; cropSequence: string[]; planId: string | null }>;
  yearly: YearResult[];
  /** Per-scenario totals as the backend gives them (e.g. margin_10y, crop_families). */
  totals: Record<string, Dist | number | null>;
  events: ScenarioEvent[];
  moneyStatus: Status;
  moneyGaps: string[];
  readingsContext: ReadingContext[];
}

export type BadgeName = "best_profit" | "most_sustainable" | "lowest_weather_risk" | "best_for_priorities";
export const BADGES: readonly BadgeName[] = ["best_profit", "most_sustainable", "lowest_weather_risk", "best_for_priorities"];

export interface Comparison {
  baseline: string | null;
  badges: Array<{ badge: string; scenarioId: string; why: string }>;
  deltas: Array<{ scenarioId: string; versus: string; changes: Array<{ indicator: string; medianDelta: number | null; currency: string | null; unit: string | null; text: string }> }>;
  tradeOffs: Array<{ scenarioId: string; text: string }>;
  notDecided: Array<{ badge: string; reasonText: string }>;
  caveat: string;
}

export interface Simulation {
  status: Status;
  reasonText: string | null;
  method: { weather: string; runs: number | null; seed: number | null; sourceYears: string | null; note: string };
  scenarios: ScenarioResult[];
  comparison: Comparison | null;
  /** The response as returned, for components that read the backend's shape (U2, U4). */
  raw: Record<string, unknown>;
}

// ------------------------------------------------------------------ §12 economics
export interface MoneyRef {
  value: number | null;
  unit: string | null;
  origin: Origin;
  source: (SourceRef & { years: string | null }) | null;
}
export interface CropEconomics {
  cropId: string;
  status: Status;
  reasonText: string | null;
  price: { low: number | null; typical: number | null; high: number | null; unit: string | null; origin: Origin; source: MoneyRef["source"] } | null;
  yield: MoneyRef | null;
  costs: { items: Array<{ item: string } & MoneyRef>; totalPerArea: { value: number | null; unit: string | null } | null } | null;
}
export interface Economics {
  currency: string;
  areaUnit: "acre" | "ha";
  crops: CropEconomics[];
  equipmentCosts: Array<{ equipment: string; pass: string | null } & MoneyRef>;
  gaps: string[];
}

// ------------------------------------------------------------------ §13 crop library
export interface CropHit {
  cropId: string;
  name: string;
  family: string | null;
  roles: string[];
  origin: Origin;
  hasCalendar: boolean;
  hasEconomics: boolean;
  regionNote: string | null;
}
export interface CropSearch {
  results: CropHit[];
  canResearch: boolean;
}
export interface CropJob {
  jobId: string | null;
  jobStatus: JobStatus;
  cropId: string | null;
  reasonText: string | null;
}

// ------------------------------------------------------------------ §14 field context
export const EQUIPMENT = [
  "planter",
  "grain_drill",
  "no_till_drill",
  "broadcast_seeder",
  "sprayer",
  "roller_crimper",
  "disk",
  "chisel_plow",
  "field_cultivator",
  "combine",
  "forage_harvester",
  "irrigation_pivot",
  "irrigation_drip",
  "irrigation_none",
] as const;
export type ReadingKind = import("../inputs/schema").ReadingKind;
export { readingKinds as READING_KINDS } from "../inputs/schema";
export interface Reading {
  date: string; // YYYY-MM-DD
  kind: ReadingKind;
  value: number | null;
  depthCm?: number | null;
  note?: string | null;
  name?: string;
  unit?: string;
  moisture_basis?: "saturation" | "volumetric" | "sensor_percent" | null;
}
export interface VocabItem {
  id: string;
  label: string;
  explanation: string | null;
}

// ------------------------------------------------------------------ economics overrides and loss assumptions (browser only)
export interface CropOverride {
  price?: { value: number; unit: string } | null;
  yield?: { value: number; unit: string } | null;
  costPerArea?: { value: number; unit: string } | null;
  priceCases?: Partial<Record<"low" | "typical" | "high", { value: number; unit: string }>>;
  costItems?: Array<{ item: string; value: number; unit: string }>;
}
export interface LossAssumptions {
  /** Percent of yield lost in a dry spring, as the farmer estimates it; `null` = not set. */
  drySpringPct: number | null;
  wetSpringPct: number | null;
  heavyRainPct: number | null;
}

/** One scenario: a rotation of 1–4 seasons, cycled over the years. */
export interface Scenario {
  scenarioId: string;
  label: string;
  isBaseline: boolean;
  rotation: FieldPlan[];
  /** Zoned baseline: each zone's own rotation (keyed by zone id). Absent means the whole field follows `rotation`. */
  zoneRotations?: Record<string, FieldPlan[]>;
  /** Where it came from: the farmer's plan, a suggestion from /recommend, or built by hand. */
  from: "current" | "suggested" | "custom";
}

// ------------------------------------------------------------------ §15 demo and autofill
export interface DemoFarm {
  label: string;
  farm: Farm;
  /** Per field_id: the current rotation, equipment and readings. */
  fields: Record<string, { rotation: FieldPlan[]; equipment: string[]; readings: Reading[] }>;
  overrides: Record<string, CropOverride>;
  priorities: Record<string, number>;
  lossAssumptions: LossAssumptions;
}
export interface Autofill {
  plan: FieldPlan | null;
  dates: Array<{ field: string; value: string | null; origin: Origin; source: SourceRef | null }>;
  gaps: string[];
}
