import { z } from "zod";

const source = z.object({ title: z.string(), url: z.string().url(), quote: z.string().optional() });
export const assessmentSchema = z.object({
  status: z.string(), reason_text: z.string().nullable(), note: z.string(),
  impacts: z.array(z.object({
    key: z.string(), crop_id: z.string(), rating: z.enum(["normal", "abnormal", "unknown"]),
    effect: z.string(), normal_min: z.number().nullable(), normal_max: z.number().nullable(),
    unit: z.string().nullable(), context: z.string(), origin: z.string().nullable(), source: source.nullable(),
  })),
});
export const conditionsResponseSchema = z.object({
  status: z.string(), as_of: z.string(), note: z.string(),
  can_assess: z.boolean().optional(),
  values: z.array(z.object({
    key: z.string(), kind: z.string(), label: z.string(), unit: z.string().nullable(),
    value: z.number().nullable(), origin: z.string().nullable(), date: z.string().nullable(),
    depth_cm: z.number().nullable(), moisture_basis: z.string().nullable(), note: z.string(),
    baseline: z.object({ value: z.number().nullable(), origin: z.string(), source, note: z.string() }).passthrough().nullable(),
  })),
  assessment: assessmentSchema,
});
export const assessmentResponseSchema = z.object({ assessment: assessmentSchema });
export type FieldConditionsResponse = z.infer<typeof conditionsResponseSchema>;
export type ConditionAssessment = z.infer<typeof assessmentSchema>;
export interface ConditionsRequest {
  location: { latitude: number; longitude: number };
  readings: Array<{ date: string; kind: string; value: number | null; depth_cm?: number; note?: string; name?: string; unit?: string; moisture_basis?: string }>;
  crops: string[];
  region_key: string;
}
