import type { InputsApi } from "./api";
import { autofillResponseSchema, calendarResearchJobSchema, cropSearchSchema, economicsResearchJobSchema, economicsResponseSchema, equipmentResponseSchema, researchJobSchema, type Crop, type EconomicsDefaults, type PlanEditorValue, type Reading } from "./schema";

export const EXAMPLE_LABEL = "Example values for interface testing. These are synthetic inputs, not agricultural guidance or verified economic references.";
const meta = { example: true, label: EXAMPLE_LABEL, plan_version: "example", catalog_version: "example", snapshot_hash: null, request_id: "example-inputs" };
export const exampleLocation = { latitude: 34.98, longitude: -80.55 };
export const exampleCrops: Crop[] = [
  { crop_id: "field_corn", name: "Field corn", family: "Poaceae", roles: ["previous", "next"], origin: "verified_source", has_calendar: true, has_economics: true, region_note: "Example catalog entry for US-NC." },
  { crop_id: "soybean", name: "Soybean", family: "Fabaceae", roles: ["previous", "next"], origin: "verified_source", has_calendar: true, has_economics: true, region_note: "Example catalog entry for US-NC." },
  { crop_id: "cereal_rye", name: "Cereal rye", family: "Poaceae", roles: ["cover", "winter_grain"], origin: "verified_source", has_calendar: true, has_economics: false, region_note: "Example catalog entry; money references are missing." },
];
export const exampleSearch = cropSearchSchema.parse({ meta, results: exampleCrops, can_research: true });
export const exampleResearchCrop: Crop = {
  crop_id: "okra", name: "Okra", family: "Malvaceae", roles: ["next"], origin: "ai_suggested", has_calendar: false, has_economics: false,
  sources: [{ title: "Example AI citation: NC State Extension, Okra", url: "https://plants.ces.ncsu.edu/plants/abelmoschus-esculentus/" }],
  region_note: "Example research result. Local dates and economics have not been checked.",
};
export const exampleResearchPending = researchJobSchema.parse({ meta, job_id: "example-okra", job_status: "pending", progress: "Checking published references for okra…" });
export const exampleResearchReady = researchJobSchema.parse({ meta, job_id: "example-okra", job_status: "ready", crop: exampleResearchCrop });
const calendarSource = { title: "Example calendar reference (synthetic date)", url: "https://content.ces.ncsu.edu/" };
export const examplePlan: PlanEditorValue = {
  plan: { plan_id: "example-current", previous_crop_id: "field_corn", prev_harvest: "10-10", winter: { kind: "cover", crop_id: "cereal_rye", seed: "10-25", terminate: "04-10" }, next_crop_id: "soybean", next_plant: "05-05", region: "US-NC" },
  dates: [
    { field: "prev_harvest", value: "10-10", origin: "assumed", source: calendarSource },
    { field: "winter.seed", value: "10-25", origin: "dataset_estimate", source: calendarSource },
    { field: "winter.terminate", value: "04-10", origin: "assumed", source: calendarSource },
    { field: "next_plant", value: "05-05", origin: "dataset_estimate", source: calendarSource },
  ], cropDetails: exampleCrops,
};
export const exampleAutofill = autofillResponseSchema.parse({
  meta, plan: examplePlan.plan, dates: examplePlan.dates, gaps: [], research: { available: true, region_key: "US-NC" },
  calendar_research: [{ crop_id: "field_corn", role: "previous", researched_at: null, missing: false }, { crop_id: "cereal_rye", role: "cover", researched_at: null, missing: false }, { crop_id: "soybean", role: "next", researched_at: null, missing: false }],
});
export const exampleCalendarResearchPending = (cropId: string) => calendarResearchJobSchema.parse({ meta, job_id: `example-calendar-${cropId}`, job_status: "pending", status: "pending", crop_id: cropId, region_key: "US-NC" });
export const exampleCalendarResearchReady = (cropId: string) => calendarResearchJobSchema.parse({ meta, job_id: `example-calendar-${cropId}`, job_status: "ready", status: "complete", crop_id: cropId, region_key: "US-NC", found: { calendars: 1 } });
const priceSource = { title: "Example price reference (synthetic values)", url: "https://www.nass.usda.gov/", years: "2021-2025" };
const yieldSource = { title: "Example county yield reference (synthetic value)", url: "https://www.nass.usda.gov/", year: 2024 };
const costSource = { title: "Example production cost reference (synthetic value)", url: "https://www.ers.usda.gov/", year: 2024 };
export const exampleEconomics = economicsResponseSchema.parse({
  meta, currency: "USD", area_unit: "acre", research: { available: true, region_key: "US-NC" }, crops: [
    { crop_id: "soybean", price: { low: 9.5, typical: 11.2, high: 13.6, unit: "USD/bu", origin: "verified_source", source: priceSource }, yield: { value: 44, unit: "bu/acre", origin: "dataset_estimate", source: yieldSource }, costs: { items: [{ item: "seed", value: 62, unit: "USD/acre", origin: "verified_source", source: costSource }, { item: "fertilizer", value: null, unit: "USD/acre", origin: "verified_source", source: costSource }] }, status: "partial", reason_text: "Example: fertilizer costs are missing." },
    { crop_id: "field_corn", price: { low: 3.8, typical: 4.5, high: 6.1, unit: "USD/bu", origin: "verified_source", source: priceSource }, yield: { value: 155, unit: "bu/acre", origin: "dataset_estimate", source: yieldSource }, costs: { items: [{ item: "seed", value: 118, unit: "USD/acre", origin: "verified_source", source: costSource }, { item: "fuel", value: 34, unit: "USD/acre", origin: "verified_source", source: costSource }] }, status: "complete" },
    { crop_id: "cereal_rye", price: { low: null, typical: null, high: null, unit: "USD/bu", origin: "assumed" }, yield: { value: null, unit: "bu/acre", origin: "assumed" }, costs: { items: [] }, status: "unavailable", reason_text: "Example: no regional economics reference is available for this crop.", economics_research: { researched_at: null, status: null } },
  ], equipment_costs: [], gaps: ["Example references leave gaps blank; enter values you know."],
});
const researchSource = { title: "Example AI-found citation (synthetic values)", url: "https://content.ces.ncsu.edu/", year: 2024, evidence_quote: "Example quoted sentence from the cited page (synthetic)." };
/** The example crop after its research job finished: a quote-checked price and yield, and one cost the code could not check. */
export const exampleResearchedEconomicsCrop = economicsResponseSchema.shape.crops.element.parse({
  crop_id: "cereal_rye", price: { low: 6.5, typical: 7.8, high: 9.4, unit: "USD/bu", origin: "source_checked", source: researchSource },
  yield: { value: 28, unit: "bu/acre", origin: "source_checked", source: researchSource }, costs: { items: [] }, status: "partial",
  reason_text: "Example: costs were not found on a checked page.", economics_research: { researched_at: "2026-01-01T00:00:00Z", status: "partial" },
  suggestions: [{ field: "costs", item: "seed", value: 40, unit: "USD/acre", year: 2024, origin: "ai_suggested", source: { ...researchSource, evidence_quote: "Example quoted sentence about seed cost (synthetic)." }, note: "Example suggestion; the quote could not be found on the page." }],
});
export const exampleEconomicsResearchPending = (cropId: string) => economicsResearchJobSchema.parse({ meta, job_id: `example-economics-${cropId}`, job_status: "pending", status: "pending", crop_id: cropId, region_key: "US-NC" });
export const exampleEconomicsResearchReady = (cropId: string) => economicsResearchJobSchema.parse({ meta, job_id: `example-economics-${cropId}`, job_status: "ready", status: "complete", crop_id: cropId, region_key: "US-NC", found: { price: 3, yield: 1, cost: 0 } });
export const exampleEquipment = equipmentResponseSchema.parse({ meta, equipment: [
  { id: "planter", label: "Planter" }, { id: "grain_drill", label: "Grain drill" }, { id: "no_till_drill", label: "No-till drill" },
  { id: "broadcast_seeder", label: "Broadcast seeder" }, { id: "sprayer", label: "Sprayer" }, { id: "roller_crimper", label: "Roller crimper" },
  { id: "disk", label: "Disk" }, { id: "chisel_plow", label: "Chisel plow" }, { id: "field_cultivator", label: "Field cultivator" },
  { id: "combine", label: "Combine" }, { id: "forage_harvester", label: "Forage harvester" }, { id: "irrigation_pivot", label: "Pivot irrigation" },
  { id: "irrigation_drip", label: "Drip irrigation" }, { id: "irrigation_none", label: "No irrigation" }, { id: "other", label: "Other equipment" },
] });
export const exampleReadings: Reading[] = [
  { date: "2026-04-02", kind: "soil_moisture_pct", value: 23.5, origin: "grower", note: "Example sensor reading beside the gate." },
  { date: "2026-04-05", kind: "soil_moisture_pct", value: 20, origin: "grower" },
  { date: "2026-04-12", kind: "soil_moisture_pct", value: 27, origin: "grower" },
  { date: "2026-04-12", kind: "rainfall_mm", value: 0, origin: "grower", note: "Example rain gauge reading." },
  { date: "2026-04-12", kind: "soil_temp_c", value: 14, origin: "grower" },
];

// Explicitly opt in; live clients never substitute examples after a failed request.
export function createExampleInputsApi(): InputsApi {
  const researched = new Set<string>();
  const withResearch = (data: EconomicsDefaults): EconomicsDefaults => ({ ...data, crops: data.crops.map(crop => researched.has(crop.crop_id) && crop.crop_id === exampleResearchedEconomicsCrop.crop_id ? exampleResearchedEconomicsCrop : crop) });
  return {
    search: async query => ({ ...exampleSearch, results: exampleCrops.filter(crop => crop.name.toLowerCase().includes(query.toLowerCase())) }),
    research: async name => {
      if (name.toLowerCase() !== "okra") throw new Error("Example research supports 'okra'. Search for okra or use the live service for another crop.");
      return exampleResearchPending;
    },
    researchJob: async () => exampleResearchReady,
    crop: async cropId => { const crop = [...exampleCrops, exampleResearchCrop].find(item => item.crop_id === cropId); if (!crop) throw new Error("No example for this crop."); return crop; },
    autofill: async request => {
      // Return the fixture only for its documented crops and location; no agronomy is inferred.
      if (!("latitude" in request.location) || request.location.latitude !== exampleLocation.latitude || request.location.longitude !== exampleLocation.longitude) throw new Error("Example dates are available only at the example location.");
      const expected = { previous: "field_corn", cover: "cereal_rye", next: "soybean" };
      if (request.crops.some(crop => crop.crop_id !== expected[crop.role])) throw new Error("No example dates for that crop sequence. Switch to the live service.");
      return exampleAutofill;
    },
    estimate: async request => withResearch({ ...exampleEconomics, crops: exampleEconomics.crops.filter(crop => request.crops.includes(crop.crop_id)) }),
    // The first poll after the job starts reports it finished; no timers, so tests stay deterministic.
    economicsResearch: async cropId => exampleEconomicsResearchPending(cropId),
    economicsResearchJob: async jobId => { const cropId = jobId.replace("example-economics-", ""); researched.add(cropId); return exampleEconomicsResearchReady(cropId); },
    calendarResearch: async cropId => exampleCalendarResearchPending(cropId),
    calendarResearchJob: async jobId => exampleCalendarResearchReady(jobId.replace("example-calendar-", "")),
    equipment: async () => exampleEquipment,
  };
}
