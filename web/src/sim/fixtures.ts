import { scenarioSchema, simulateRequestSchema, simulationResultSchema, type Scenario } from "./schema";

export const EXAMPLE_LABEL = "Example values · synthetic demonstration, not a farm result";
// All figures below are synthetic UI examples, not source records or simulated outputs.
const annual = (values: readonly (readonly [number, number, number, number, number, number, number, number])[]) => values.map(([year, p10, median, p90, rainP10, rainMedian, rainP90, cover]) => ({
  year, money: { margin: { p10, median, p90, currency: "USD", origin: "calculation" as const, includes_assumption: "dry_spring_pct" } },
  indicators: { rain_on_bare_soil_mm: { p10: rainP10, median: rainMedian, p90: rainP90, unit: "mm", origin: "calculation" as const }, living_cover_days: { median: cover, unit: "days", origin: "calculation" as const } },
}));
const readings = [
  { date: "2026-04-02", kind: "soil_moisture_pct", value: 23.5, depth_cm: 10, origin: "grower", modeled_same_day: { gwettop: 0.41, origin: "nasa_modeled" } },
  { date: "2026-04-09", kind: "soil_moisture_pct", value: 20.1, depth_cm: 10, origin: "grower", modeled_same_day: { gwettop: 0.36, origin: "nasa_modeled" } },
  { date: "2026-04-16", kind: "soil_moisture_pct", value: 27.2, depth_cm: 10, origin: "grower", modeled_same_day: { gwettop: 0.52, origin: "nasa_modeled" } },
];
export const currentExample = scenarioSchema.parse({
  scenario_id: "current", label: "What I do now", status: "complete", example_label: EXAMPLE_LABEL,
  timeline: [{ year: 2027, season: "2027", crop_sequence: ["field_corn", "soybean"], plan_id: "example_current" }],
  yearly: annual([
    [2027, 9800, 13100, 16900, 120, 260, 421, 190], [2028, 9500, 12800, 17200, 132, 271, 432, 188],
    [2029, 9700, 13200, 17000, 118, 254, 415, 192], [2030, 9400, 13000, 17100, 124, 266, 438, 189],
    [2031, 9600, 13400, 17600, 121, 258, 424, 191], [2032, 9900, 12900, 16900, 127, 264, 429, 190],
    [2033, 9800, 13300, 17400, 122, 261, 426, 190], [2034, 9700, 13100, 17000, 116, 250, 412, 193],
    [2035, 9300, 12800, 16800, 128, 269, 436, 187], [2036, 9600, 13400, 17500, 119, 251, 418, 190],
  ]),
  totals: { margin_10y: { p10: 98000, median: 131000, p90: 165000, currency: "USD", origin: "calculation", includes_assumption: "dry_spring_pct" }, living_cover_days_per_year: { median: 190, unit: "days", origin: "calculation" }, rain_on_bare_soil_mm_per_year: { median: 260.4, unit: "mm", origin: "calculation" }, crop_families: { value: 2, origin: "calculation" }, operations_per_year: { value: 6.5, origin: "calculation" } },
  events: [{ event: "dry_springs_ge_3_in_10y", probability: 0.34, text: "3 or more dry springs in 10 years occurred in 34% of replays.", origin: "calculation" }, { event: "heavy_rain_ge_3_in_10y", probability: 0.19, text: "3 or more heavy-rain seasons in 10 years occurred in 19% of replays.", origin: "calculation" }],
  money_status: "complete", money_gaps: [], readings_context: readings,
});
export const ryeExample = scenarioSchema.parse({
  scenario_id: "rye", label: "Add cereal rye", status: "complete", example_label: EXAMPLE_LABEL,
  yearly: annual([
    [2027, 10700, 14200, 17900, 64, 160, 283, 242], [2028, 10500, 13900, 18000, 71, 174, 296, 240],
    [2029, 10800, 14400, 18200, 65, 158, 278, 244], [2030, 10400, 14100, 18100, 70, 169, 292, 241],
    [2031, 10900, 14500, 18400, 62, 155, 274, 243], [2032, 10600, 14000, 17800, 66, 164, 286, 242],
    [2033, 11000, 14300, 18300, 68, 162, 281, 242], [2034, 10700, 14200, 18000, 59, 151, 269, 245],
    [2035, 10300, 13900, 17700, 73, 177, 301, 239], [2036, 10900, 14500, 18400, 63, 160, 280, 242],
  ]),
  totals: { margin_10y: { p10: 105000, median: 142000, p90: 179000, currency: "USD", origin: "calculation", includes_assumption: "dry_spring_pct" }, living_cover_days_per_year: { median: 242, unit: "days", origin: "calculation" }, rain_on_bare_soil_mm_per_year: { median: 163, unit: "mm", origin: "calculation" }, crop_families: { value: 3, origin: "calculation" }, operations_per_year: { value: 7.5, origin: "calculation" } },
  events: [{ event: "dry_springs_ge_3_in_10y", probability: 0.38, text: "3 or more dry springs in 10 years occurred in 38% of replays.", origin: "calculation" }, { event: "heavy_rain_ge_3_in_10y", probability: 0.18, text: "3 or more heavy-rain seasons in 10 years occurred in 18% of replays.", origin: "calculation" }],
  money_status: "complete", money_gaps: [], readings_context: readings,
});
export const diverseExample = scenarioSchema.parse({
  scenario_id: "diverse", label: "Add wheat and clover", status: "complete", example_label: EXAMPLE_LABEL,
  yearly: annual([
    [2027, 8500, 11900, 15600, 53, 140, 251, 259], [2028, 8300, 11700, 15400, 59, 149, 263, 257],
    [2029, 8600, 12000, 15800, 51, 136, 246, 261], [2030, 8200, 11800, 15500, 56, 145, 257, 258],
    [2031, 8800, 12200, 16000, 50, 133, 243, 260], [2032, 8400, 11600, 15300, 54, 142, 254, 259],
    [2033, 8700, 12100, 15900, 55, 141, 250, 259], [2034, 8500, 11900, 15600, 48, 130, 239, 262],
    [2035, 8100, 11600, 15200, 61, 152, 267, 256], [2036, 8800, 12200, 16000, 52, 138, 248, 259],
  ]),
  totals: { margin_10y: { p10: 91000, median: 119000, p90: 153000, currency: "USD", origin: "calculation", includes_assumption: "dry_spring_pct" }, living_cover_days_per_year: { median: 259, unit: "days", origin: "calculation" }, rain_on_bare_soil_mm_per_year: { median: 142, unit: "mm", origin: "calculation" }, crop_families: { value: 4, origin: "calculation" }, operations_per_year: { value: 8.5, origin: "calculation" } },
  events: [{ event: "dry_springs_ge_3_in_10y", probability: 0.29, text: "3 or more dry springs in 10 years occurred in 29% of replays.", origin: "calculation" }, { event: "heavy_rain_ge_3_in_10y", probability: 0.14, text: "3 or more heavy-rain seasons in 10 years occurred in 14% of replays.", origin: "calculation" }],
  money_status: "complete", money_gaps: [], readings_context: readings,
});
export const simulationExample = simulationResultSchema.parse({
  meta: { fixture: EXAMPLE_LABEL }, example_label: EXAMPLE_LABEL, status: "complete",
  method: { weather: "historical_resampling", runs: 200, seed: 7, source_years: "1981–2025", note: "An evidence-based outlook: this field's real past seasons (1981-2025) replayed in new orders over the next 10 seasons. Rain is adjusted for the trend observed in this record. It shows what to plan for under conditions seen here; it cannot say what any single year will bring.", origin: "calculation" },
  scenarios: [currentExample, ryeExample, diverseExample],
  comparison: {
    baseline: "current",
    badges: [
      { badge: "best_profit", scenario_id: "rye", why: "Highest median 10-year margin: $142,000, compared with $131,000 for the current plan.", origin: "calculation" },
      { badge: "most_sustainable", scenario_id: "diverse", why: "259 living-cover days per year, 142 mm of rain on bare soil, and 4 crop families give this example the strongest soil and water indicators.", origin: "calculation" },
      { badge: "lowest_weather_risk", scenario_id: "diverse", why: "The fewest stress events across the example replays; 29% included 3 or more dry springs.", origin: "calculation" },
      { badge: "best_for_priorities", scenario_id: "rye", why: "Your emphasis on margin and soil cover favours this plan, with $142,000 median margin and 242 cover days per year.", origin: "calculation" },
    ],
    deltas: [
      { scenario_id: "rye", versus: "current", changes: [{ indicator: "margin_10y", median_delta: 11000, currency: "USD", text: "+$11,000 over 10 years (median)", origin: "calculation" }, { indicator: "living_cover_days_per_year", median_delta: 52, unit: "days", text: "52 more days with a living crop each year.", origin: "calculation" }, { indicator: "rain_on_bare_soil_mm_per_year", median_delta: -97.4, unit: "mm", text: "97.4 mm less rain on bare soil each year.", origin: "calculation" }] },
      { scenario_id: "diverse", versus: "current", changes: [{ indicator: "margin_10y", median_delta: -12000, currency: "USD", text: "$12,000 less over 10 years (median).", origin: "calculation" }, { indicator: "living_cover_days_per_year", median_delta: 69, unit: "days", text: "69 more days with a living crop each year.", origin: "calculation" }] },
    ],
    trade_offs: [{ scenario_id: "current", text: "Fewer field passes, but more rain falls without living cover than in the alternatives.", origin: "calculation" }, { scenario_id: "rye", text: "More living cover and a higher example margin, with one extra field operation each year and more dry-spring events.", origin: "calculation" }, { scenario_id: "diverse", text: "More cover and fewer stress events, with a lower median margin and two extra field operations each year.", origin: "calculation" }],
    not_decided: [], caveat: "The stronger of the plans you compared, given these numbers and the conditions seen at this field. An evidence-based outlook, not a guarantee.",
  },
});
export const missingMoneyExample: Scenario = scenarioSchema.parse({
  ...diverseExample, status: "partial", money_status: "partial",
  money_gaps: [{ crop_id: "clover", reason_text: "No local clover price or harvest cost was supplied. Enter your own numbers to include this crop in margin.", origin: "calculation" }],
  totals: { ...diverseExample.totals, margin_10y: { median: null, p10: null, p90: null, currency: "USD", origin: "calculation", status: "insufficient_data" } },
  yearly: diverseExample.yearly.map(y => ({ ...y, money: { margin: { median: null, p10: null, p90: null, currency: "USD", origin: "calculation" } } })),
});
export const partialSimulationExample = simulationResultSchema.parse({
  ...simulationExample, status: "partial", scenarios: [currentExample, ryeExample, missingMoneyExample],
  comparison: { ...simulationExample.comparison, badges: simulationExample.comparison!.badges.filter(b => b.badge !== "best_profit" && b.badge !== "best_for_priorities"), deltas: simulationExample.comparison!.deltas.filter(d => d.scenario_id !== "diverse"), not_decided: [{ badge: "best_profit", reason_text: "A profit badge needs complete money inputs for every plan. Clover price and harvest cost are missing.", origin: "calculation" }, { badge: "best_for_priorities", reason_text: "Your priorities include profit, which could not be compared for every plan.", origin: "calculation" }] },
});
export const simulateRequestExample = simulateRequestSchema.parse({
  location: { latitude: 34.98, longitude: -80.55 },
  field: { field_id: "example_field", name: "Example field", area_ha: 16.2, geometry: null, equipment: ["planter", "grain_drill", "sprayer", "combine"], readings: [] },
  goals: { priorities: { soil_cover: 2, water_conservation: 2, weather_resilience: 1, crop_diversity: 1, living_cover_duration: 1, management_simplicity: 1, profit: 3 } },
  economics: { overrides: { soybean: { price: { value: 11.2, unit: "USD/bu", origin: "grower" }, yield: { value: 48, unit: "bu/acre", origin: "grower" } } }, loss_assumptions: { dry_spring_pct: 15, heavy_rain_pct: null } },
  scenarios: [{ scenario_id: "current", label: "What I do now", is_baseline: true, rotation: [{ plan_id: "example_current", previous_crop_id: "field_corn", prev_harvest: "09-20", winter: { kind: "none" }, next_crop_id: "soybean", next_plant: "05-12" }] }],
  years: 10, runs: 200, seed: 7, start_season: "2027",
});
