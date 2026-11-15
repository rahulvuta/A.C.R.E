import { z } from "zod";

export const originSchema = z.enum(["grower", "verified_source", "dataset_estimate", "ai_suggested", "source_checked", "assumed", "calculation", "nasa_measured", "nasa_modeled"]);
export type Origin = z.infer<typeof originSchema>;
export const statusSchema = z.enum(["complete", "partial", "unavailable", "unknown", "inapplicable", "unsupported", "invalid_input", "manual_check", "insufficient_data"]);
export const sourceSchema = z.object({ title: z.string().optional(), url: z.string().nullable().optional(), years: z.string().optional(), year: z.union([z.string(), z.number()]).optional() }).passthrough();
export type Source = z.infer<typeof sourceSchema>;
const meta = z.record(z.unknown());
export const locationSchema = z.union([
  z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) }).strict(),
  z.object({ cell_id: z.string().min(1) }).strict(),
]);
export type InputLocation = z.infer<typeof locationSchema>;
export const areaSchema = z.object({ value: z.number().finite().nonnegative().nullable(), unit: z.enum(["acre", "ha"]) });
export type InputArea = z.infer<typeof areaSchema>;
export const monthDaySchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Use MM-DD, for example 04-20.").refine(v => Number(v.slice(3)) <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(v.slice(0, 2)) - 1]!, "Use a valid month and day.");
export const cropSchema = z.object({
  crop_id: z.string().min(1), name: z.string().min(1), family: z.string().nullable().optional(),
  roles: z.array(z.string()), origin: originSchema,
  has_calendar: z.boolean().nullable().optional(), has_economics: z.boolean().nullable().optional(),
  region_note: z.string().nullable().optional(), sources: z.array(sourceSchema).optional(),
  scientific_name: z.string().nullable().optional(),
  calendars: z.array(z.object({ region_key: z.string(), origin: originSchema, source: sourceSchema.nullable().optional() }).passthrough()).optional(),
  economics_refs: z.array(z.unknown()).optional(),
}).passthrough();
export type Crop = z.infer<typeof cropSchema>;
export const cropSearchSchema = z.object({ meta, results: z.array(cropSchema), can_research: z.boolean() });
export const researchJobSchema = z.object({
  meta, job_id: z.string().min(1), job_status: z.enum(["pending", "ready", "failed"]),
  crop_id: z.string().nullable().optional(), crop: cropSchema.nullable().optional(),
  progress: z.string().nullable().optional(), reason_text: z.string().nullable().optional(),
}).superRefine((job, ctx) => {
  if (job.crop && !["ai_suggested", "source_checked"].includes(job.crop.origin)) ctx.addIssue({ code: "custom", path: ["crop", "origin"], message: "AI research must keep its AI provenance." });
});
export type ResearchJob = z.infer<typeof researchJobSchema>;
export const dateFields = ["prev_harvest", "winter.seed", "winter.terminate", "winter.plant", "winter.harvest", "next_plant"] as const;
export type DateField = typeof dateFields[number];
export const dateEvidenceSchema = z.object({ field: z.enum(dateFields), value: monthDaySchema.nullable(), origin: originSchema.nullable(), source: sourceSchema.nullable().optional() });
export type DateEvidence = z.infer<typeof dateEvidenceSchema>;
export const planDraftSchema = z.object({
  plan_id: z.string(), label: z.string().nullable().optional(),
  previous_crop_id: z.string().nullable(), prev_harvest: monthDaySchema.nullable(),
  winter: z.object({ kind: z.enum(["none", "cover", "winter_grain"]), crop_id: z.string().nullable().optional(), seed: monthDaySchema.nullable().optional(), terminate: monthDaySchema.nullable().optional(), plant: monthDaySchema.nullable().optional(), harvest: monthDaySchema.nullable().optional() }),
  next_crop_id: z.string().nullable(), next_plant: monthDaySchema.nullable(), region: z.string().nullable().optional(),
}).passthrough();
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type PlanEditorValue = { plan: PlanDraft; dates: DateEvidence[]; cropDetails: Crop[] };
export const autofillRequestSchema = z.object({ location: locationSchema, crops: z.array(z.object({ role: z.enum(["previous", "cover", "next"]), crop_id: z.string().min(1) })).min(1) });
export type AutofillRequest = z.infer<typeof autofillRequestSchema>;
export const autofillResponseSchema = z.object({ meta, plan: planDraftSchema.nullable(), dates: z.array(dateEvidenceSchema), gaps: z.array(z.union([z.string(), z.object({ text: z.string() }).passthrough()]).transform(gap => typeof gap === "string" ? gap : gap.text)) });
export const quantitySchema = z.object({ value: z.number().finite().nullable(), unit: z.string(), origin: originSchema, source: sourceSchema.nullable().optional() });
export type Quantity = z.infer<typeof quantitySchema>;
export const priceSchema = z.object({ low: z.number().finite().nullable(), typical: z.number().finite().nullable(), high: z.number().finite().nullable(), unit: z.string(), origin: originSchema, source: sourceSchema.nullable().optional() });
export const economicsCropSchema = z.object({
  crop_id: z.string(), aliases: z.array(z.string()).default([]), price: priceSchema.nullable(), yield: quantitySchema.nullable(),
  costs: z.object({ items: z.array(quantitySchema.extend({ item: z.string() })), total_per_area: quantitySchema.partial({ origin: true }).nullable().optional() }),
  status: statusSchema, reason_text: z.string().nullable().optional(),
});
export const economicsResponseSchema = z.object({ meta, status: statusSchema.optional(), currency: z.string().nullable(), area_unit: z.enum(["acre", "ha"]), crops: z.array(economicsCropSchema), equipment_costs: z.array(quantitySchema.extend({ equipment: z.string(), pass: z.string() })).default([]), gaps: z.array(z.string()) });
export type EconomicsDefaults = z.infer<typeof economicsResponseSchema>;
export type CropEconomics = z.infer<typeof economicsCropSchema>;
export type PriceCase = "low" | "typical" | "high";
export type CropOverrides = { price?: Partial<Record<PriceCase, Quantity>>; yield?: Quantity; costs?: Record<string, Quantity> };
export type EconomicsValue = {
  overrides: Record<string, CropOverrides>;
  loss_assumptions: { dry_spring_pct: number | null; heavy_rain_pct: number | null };
};
export const economicsRequestSchema = z.object({ location: locationSchema, crops: z.array(z.string().min(1)).min(1), area: areaSchema.nullable(), equipment: z.array(z.string()), overrides: z.record(z.unknown()) });
export type EconomicsRequest = z.infer<typeof economicsRequestSchema>;
export const equipmentResponseSchema = z.object({ meta, equipment: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })) });
export type EquipmentOption = z.infer<typeof equipmentResponseSchema>["equipment"][number];
export const readingKinds = ["soil_moisture_pct", "soil_moisture_vwc", "rainfall_mm", "soil_temp_c", "note"] as const;
export type ReadingKind = typeof readingKinds[number];
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const date = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
}, "Choose a valid date.");
export const readingSchema = z.object({ date: calendarDateSchema, kind: z.enum(readingKinds), value: z.number().finite().nullable(), depth_cm: z.number().finite().min(0).max(300).nullable().optional(), note: z.string().max(500).nullable().optional(), origin: z.literal("grower") }).superRefine((reading, ctx) => {
  if (reading.kind === "note") {
    if (reading.value !== null) ctx.addIssue({ code: "custom", path: ["value"], message: "A field note has no numeric value." });
    if (!reading.note?.trim()) ctx.addIssue({ code: "custom", path: ["note"], message: "Write a note." });
  } else if (reading.value === null) ctx.addIssue({ code: "custom", path: ["value"], message: "Enter a reading; leave it blank if you do not know it." });
  const bounds: Partial<Record<ReadingKind, [number, number]>> = { soil_moisture_pct: [0, 100], soil_moisture_vwc: [0, 1], rainfall_mm: [0, 1000], soil_temp_c: [-30, 60] };
  const range = bounds[reading.kind];
  if (reading.value !== null && range && (reading.value < range[0] || reading.value > range[1])) ctx.addIssue({ code: "custom", path: ["value"], message: `Enter a value between ${range[0]} and ${range[1]}.` });
});
export type Reading = z.infer<typeof readingSchema>;
