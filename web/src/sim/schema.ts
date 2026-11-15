import { z } from "zod";
import { planSchema } from "../planning/api";

export const originSchema = z.enum(["grower", "verified_source", "dataset_estimate", "ai_suggested", "source_checked", "assumed", "calculation", "nasa_measured", "nasa_modeled"]);
export type Origin = z.infer<typeof originSchema>;
export const statusSchema = z.enum(["complete", "partial", "unavailable", "unknown", "inapplicable", "unsupported", "invalid_input", "manual_check", "insufficient_data"]);
const number = z.number().finite();
const blankNumber = number.nullable().optional();
const sourceSchema = z.object({ title: z.string().optional(), url: z.string().nullable().optional() }).passthrough();
const evidence = {
  origin: originSchema.nullable().optional(),
  status: statusSchema.optional(),
  source: sourceSchema.nullable().optional(),
  reason_text: z.string().nullable().optional(),
};

// Some §11 examples omit summary provenance. Preserve that gap rather than inventing an origin.
export const distributionSchema = z.object({
  p10: blankNumber, median: blankNumber, p90: blankNumber, value: blankNumber,
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), unit: z.string().optional(),
  includes_assumption: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  ...evidence,
}).passthrough();
export type Distribution = z.infer<typeof distributionSchema>;
const summarySchema = z.union([distributionSchema, number, z.null()]);
export type SummaryValue = z.infer<typeof summarySchema>;
const probabilitySchema = z.object({ probability: number.min(0).max(1).nullable().optional(), ...evidence }).passthrough();
export const eventSchema = probabilitySchema.extend({ event: z.string(), text: z.string().nullable().optional() });
export type ScenarioEvent = z.infer<typeof eventSchema>;
export const reasonSchema = z.union([z.string(), z.object({
  text: z.string().nullable().optional(), reason: z.string().nullable().optional(),
  badge: z.string().optional(),
  crop_id: z.string().optional(), field: z.string().optional(), ...evidence,
}).passthrough()]);
export type Reason = z.infer<typeof reasonSchema>;
export const readingSchema = z.object({
  date: z.string(), kind: z.enum(["soil_moisture_pct", "soil_moisture_vwc", "rainfall_mm", "soil_temp_c", "note"]),
  value: z.union([number, z.string(), z.null()]), depth_cm: blankNumber, note: z.string().nullable().optional(),
  ...evidence,
  modeled_same_day: z.object({ gwettop: blankNumber, ...evidence }).passthrough().nullable().optional(),
}).passthrough();
export type Reading = z.infer<typeof readingSchema>;
const monthDist = z.object({ p10: blankNumber, median: blankNumber, p90: blankNumber }).passthrough();
export const monthlySchema = z.object({
  currency: z.string().optional(), origin: originSchema.nullable().optional(),
  timing_origin: originSchema.nullable().optional(), timing_text: z.string().nullable().optional(),
  includes_assumption: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  months: z.array(z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    costs: monthDist.nullable().optional(), revenue: monthDist.nullable().optional(),
    net: monthDist.nullable().optional(), cumulative_net: monthDist.nullable().optional(),
    operations: z.array(z.object({ kind: z.string(), crop_id: z.string().nullable().optional() }).passthrough()).default([]),
    risks: z.array(z.object({ kind: z.string(), probability: number.min(0).max(1).nullable().optional(), text: z.string().nullable().optional() }).passthrough()).default([]),
  }).passthrough()).default([]),
}).passthrough();
export type ScenarioMonthly = z.infer<typeof monthlySchema>;
export type MonthlyMonth = ScenarioMonthly["months"][number];
export const scenarioSchema = z.object({
  scenario_id: z.string(), label: z.string(), status: statusSchema,
  example_label: z.string().optional(), reason_text: z.string().nullable().optional(),
  timeline: z.array(z.object({ year: number.int(), season: z.string(), crop_sequence: z.array(z.string()), plan_id: z.string().nullable().optional() }).passthrough()).default([]),
  yearly: z.array(z.object({
    year: number.int(),
    indicators: z.record(distributionSchema.extend({ probability: number.min(0).max(1).nullable().optional() }).nullable()).default({}),
    money: z.object({ revenue: distributionSchema.nullable().optional(), costs: distributionSchema.nullable().optional(), margin: distributionSchema.nullable().optional() }).passthrough().nullable().optional(),
  }).passthrough()).default([]),
  totals: z.object({
    margin_10y: distributionSchema.nullable().optional(),
    living_cover_days_per_year: summarySchema.optional(),
    rain_on_bare_soil_mm_per_year: summarySchema.optional(),
    crop_families: summarySchema.optional(), operations_per_year: summarySchema.optional(),
    origins: z.record(originSchema).optional(),
  }).passthrough().nullable().optional(),
  events: z.array(eventSchema).default([]),
  money_status: statusSchema,
  money_gaps: z.array(reasonSchema).default([]),
  /** Month-by-month money (null when money is not complete); absent in older responses. */
  monthly: monthlySchema.nullable().optional(),
  readings_context: z.array(readingSchema).default([]),
}).passthrough();
export type Scenario = z.infer<typeof scenarioSchema>;
export const badgeIds = ["best_profit", "most_sustainable", "lowest_weather_risk", "best_for_priorities"] as const;
export const badgeSchema = z.object({ badge: z.enum(badgeIds), scenario_id: z.string(), why: z.string().nullable(), ...evidence }).passthrough();
export type ScenarioBadge = z.infer<typeof badgeSchema>;
export const deltaChangeSchema = z.object({
  indicator: z.string(), median_delta: blankNumber, currency: z.string().optional(),
  unit: z.string().optional(), text: z.string().nullable().optional(), ...evidence,
}).passthrough();
export type DeltaChange = z.infer<typeof deltaChangeSchema>;
export const deltaSchema = z.object({ scenario_id: z.string(), versus: z.string(), changes: z.array(deltaChangeSchema) });
export type ScenarioDelta = z.infer<typeof deltaSchema>;
export const simulationResultSchema = z.object({
  meta: z.record(z.unknown()).optional(), status: statusSchema,
  example_label: z.string().optional(), reason_text: z.string().nullable().optional(), gaps: z.array(reasonSchema).default([]),
  method: z.object({ weather: z.literal("historical_resampling"), runs: number.int(), seed: number.int(), source_years: z.string(), note: z.string(), origin: originSchema.optional() }).passthrough().nullable().optional(),
  scenarios: z.array(scenarioSchema).max(6).default([]),
  comparison: z.object({
    baseline: z.string().nullable().optional(), badges: z.array(badgeSchema).default([]),
    deltas: z.array(deltaSchema).default([]),
    trade_offs: z.array(z.object({ scenario_id: z.string(), text: z.string(), ...evidence }).passthrough()).default([]),
    not_decided: z.array(reasonSchema).default([]), caveat: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();
export type SimulationResult = z.infer<typeof simulationResultSchema>;

const inputValue = z.object({ value: number.nullable(), unit: z.string(), origin: originSchema.optional(), source: sourceSchema.optional() }).passthrough();
const scenarioInput = z.object({ scenario_id: z.string().min(1), label: z.string().min(1), is_baseline: z.boolean().optional(), rotation: z.array(planSchema).min(1).max(4) });
export const simulateRequestSchema = z.object({
  location: z.union([z.object({ latitude: number.min(-90).max(90), longitude: number.min(-180).max(180) }), z.object({ cell_id: z.string().min(1) })]),
  field: z.object({
    field_id: z.string(), name: z.string().optional(), area_ha: number.positive().nullable(),
    geometry: z.record(z.unknown()).nullable().optional(), equipment: z.array(z.string()).default([]),
    readings: z.array(readingSchema.omit({ modeled_same_day: true })).default([]),
  }).passthrough(),
  goals: z.object({ priorities: z.record(z.enum(["soil_cover", "water_conservation", "weather_resilience", "crop_diversity", "living_cover_duration", "management_simplicity", "profit"]), number.int().min(0).max(3)) }).passthrough(),
  economics: z.object({
    overrides: z.record(z.object({ price: inputValue.optional(), yield: inputValue.optional(), costs: z.unknown().optional() }).passthrough()),
    loss_assumptions: z.object({ dry_spring_pct: number.min(0).max(100).nullable().optional(), heavy_rain_pct: number.min(0).max(100).nullable().optional() }).passthrough(),
  }).passthrough(),
  scenarios: z.array(scenarioInput).min(1).max(6), years: number.int().min(1).max(10),
  runs: number.int().min(50).max(500), seed: number.int(), start_season: z.string().regex(/^\d{4}$/),
}).superRefine((request, ctx) => {
  if (new Set(request.scenarios.map(s => s.scenario_id)).size !== request.scenarios.length) ctx.addIssue({ code: "custom", path: ["scenarios"], message: "Each scenario needs a different ID." });
  if (request.scenarios.filter(s => s.is_baseline).length > 1) ctx.addIssue({ code: "custom", path: ["scenarios"], message: "Choose only one current plan." });
});
export type SimulateRequest = z.infer<typeof simulateRequestSchema>;
export type SimulateRequestInput = z.input<typeof simulateRequestSchema>;
