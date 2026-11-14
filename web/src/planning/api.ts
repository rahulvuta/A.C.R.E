import { z } from "zod";
export const statusSchema = z.enum(["complete", "partial", "unavailable", "unknown", "inapplicable", "unsupported", "invalid_input", "manual_check", "insufficient_data"]);
export const originSchema = z.enum(["nasa_measured", "nasa_modeled", "calculation", "verified_source", "source_checked", "ai_suggested", "grower", "assumed", "dataset_estimate"]);
export type Origin = z.infer<typeof originSchema>;
export const priorityIds = ["soil_cover", "water_conservation", "weather_resilience", "crop_diversity", "living_cover_duration", "management_simplicity"] as const;
export type PriorityId = typeof priorityIds[number];
export const equipmentIds = ["no_drill_interseeding", "no_roller_crimper", "no_no_till_planter", "no_grain_drill", "no_sprayer"] as const;
const weight = z.number().int().min(0).max(3);
const monthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).refine(v => Number(v.slice(3)) <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(v.slice(0, 2)) - 1]!, "Use a valid month and day");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cropList = z.array(z.string().min(1));
export const goalsSchema = z.object({
  priorities: z.object({
    soil_cover: weight,
    water_conservation: weight,
    weather_resilience: weight,
    crop_diversity: weight,
    living_cover_duration: weight,
    management_simplicity: weight
  }).strict(),
  constraints: z.object({
    allowed_crops: cropList.nullable(),
    excluded_crops: cropList,
    must_include: cropList,
    irrigation: z.enum(["yes", "no", "unknown"]),
    equipment: z.array(z.enum(equipmentIds)),
    latest_planting: monthDay.nullable(),
    earliest_harvest: monthDay.nullable(),
    seasons: z.number().int().min(1).max(4)
  }).strict(),
  preferences: z.object({
    liked_crops: cropList,
    disliked_crops: cropList
  }).strict()
}).strict().superRefine((g, ctx) => {
  for (const crop of g.constraints.must_include) {
    if (g.constraints.excluded_crops.includes(crop) || g.constraints.allowed_crops !== null && !g.constraints.allowed_crops.includes(crop)) ctx.addIssue({
      code: "custom",
      path: ["constraints", "must_include"],
      message: `${crop} must be allowed and cannot be excluded.`
    });
  }
});
export type Goals = z.infer<typeof goalsSchema>;
export const locationSchema = z.union([z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180)
}), z.object({
  cell_id: z.string().min(1)
})]);
export type PlanningLocation = z.infer<typeof locationSchema>;
export const fieldSchema = z.object({
  field_id: z.string().nullable().optional(),
  area_ha: z.number().positive().nullable().optional(),
  crop_history: cropList.max(3).optional(),
  soil: z.record(z.unknown()).nullable().optional()
}).strict();
export type PlanningField = z.infer<typeof fieldSchema>;
export const planSchema = z.object({
  plan_id: z.string().min(1),
  label: z.string().nullable().optional(),
  previous_crop_id: z.string().min(1),
  prev_harvest: monthDay,
  winter: z.object({
    kind: z.enum(["none", "cover", "winter_grain"]),
    crop_id: z.string().nullable().optional(),
    seed: monthDay.nullable().optional(),
    terminate: monthDay.nullable().optional(),
    plant: monthDay.nullable().optional(),
    harvest: monthDay.nullable().optional()
  }),
  next_crop_id: z.string().min(1),
  next_plant: monthDay,
  region: z.string().nullable().optional(),
  production_system: z.string().nullable().optional(),
  grower: z.object({
    low_moisture_concern: z.boolean().nullable().optional(),
    residue_report: z.string().nullable().optional(),
    observations: z.array(z.string()).optional()
  }).optional()
}).superRefine((plan, ctx) => {
  const required = plan.winter.kind === "cover" ? ["crop_id", "seed", "terminate"] : plan.winter.kind === "winter_grain" ? ["crop_id", "plant", "harvest"] : [];
  const unused = plan.winter.kind === "cover" ? ["plant", "harvest"] : plan.winter.kind === "winter_grain" ? ["seed", "terminate"] : ["crop_id", "seed", "terminate", "plant", "harvest"];
  for (const name of required) if (!plan.winter[name as keyof typeof plan.winter]) ctx.addIssue({
    code: "custom",
    path: ["winter", name],
    message: "Required for this off-season management."
  });
  for (const name of unused) if (plan.winter[name as keyof typeof plan.winter] != null) ctx.addIssue({
    code: "custom",
    path: ["winter", name],
    message: "This off-season management does not use this field."
  });
});
export type Plan = z.infer<typeof planSchema>;
export const sourceSchema = z.object({
  title: z.string().optional(),
  url: z.string().nullable().optional()
}).passthrough();
export type Source = z.infer<typeof sourceSchema>;
const meta = z.record(z.unknown()).optional();
const logEntry = z.object({
  kind: z.string().optional(),
  rule: z.string().nullable().optional(),
  constraint: z.string().nullable().optional(),
  pruned: z.unknown().optional(),
  reason_text: z.string().nullable().optional()
}).passthrough();
export const generatedCandidateSchema = z.object({
  candidate_id: z.string(),
  label: z.string().nullable().optional(),
  seasons: z.array(z.object({
    season: z.number().optional(),
    year: z.number().optional(),
    plan: planSchema,
    origins: z.record(originSchema),
    sources: z.record(sourceSchema).optional()
  }).passthrough()).min(1).max(4),
  origins: z.array(originSchema).optional(),
  checks_summary: z.record(z.unknown()).optional()
}).passthrough();
export type GeneratedCandidate = z.infer<typeof generatedCandidateSchema>;
export const generateRequestSchema = z.object({
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
  }),
  field: fieldSchema.optional(),
  goals: goalsSchema.optional(),
  start_year: z.number().int().optional()
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export const generateResponseSchema = z.object({
  meta,
  status: statusSchema,
  candidates: z.array(generatedCandidateSchema).default([]),
  generation_log: z.array(logEntry).default([]),
  gaps: z.array(z.string()).default([]),
  reason_text: z.string().nullable().optional()
}).passthrough();
export type GenerateResponse = z.infer<typeof generateResponseSchema>;
export const indicatorSchema = z.object({
  value: z.number().finite().nullable(),
  unit: z.string(),
  direction: z.enum(["lower_better", "higher_better"]),
  origin: originSchema,
  status: statusSchema,
  reason: z.string().nullable().optional(),
  definition: z.string().optional(),
  rationale: z.string().optional(),
  source: sourceSchema.nullable().optional(),
  per_leg: z.array(z.union([z.number().nullable(), z.object({
    value: z.number().nullable(),
    dry_seasons: z.number().nullable(),
    eligible_seasons: z.number().nullable()
  }).passthrough()])).optional(),
  in_priorities: z.boolean().optional()
}).passthrough();
export type Indicator = z.infer<typeof indicatorSchema>;
export const replaySchema = z.object({
  method: z.literal("POST"),
  path: z.string(),
  body: z.record(z.unknown())
});
export type ReplayRequest = z.infer<typeof replaySchema>;
const historicalReplaySchema = z.object({
  status: statusSchema.optional(),
  reason_text: z.string().nullable().optional(),
  year: z.number().optional(),
  winter: z.object({
    status: statusSchema,
    rain_outside_cover_mm: z.number().nullable().optional(),
    living_cover_days: z.number().nullable().optional(),
    heavy_rain_days_outside_cover: z.number().nullable().optional()
  }).passthrough().optional(),
  spring: z.object({
    status: statusSchema,
    total_mm: z.number().nullable().optional()
  }).passthrough().optional(),
  checks_triggered: z.array(z.object({
    check_id: z.string(),
    reason: z.string(),
    source: sourceSchema.nullable().optional()
  }).passthrough()).default([])
}).passthrough();
const vulnerabilitySchema = z.object({
  year: z.union([z.string(), z.number()]),
  text: z.string(),
  plan_id: z.string().optional(),
  indicator: z.string().optional(),
  value: z.number().nullable().optional(),
  replay: replaySchema.optional()
}).passthrough();
export type Vulnerability = z.infer<typeof vulnerabilitySchema>;
const evidenceSchema = z.object({
  text: z.string(),
  origin: originSchema.optional(),
  source: sourceSchema.nullable().optional()
}).passthrough();
export const recommendationCandidateSchema = z.object({
  candidate_id: z.string(),
  label: z.string().nullable().optional(),
  origin: z.union([originSchema, z.literal("generated")]).optional(),
  plans: z.array(planSchema).max(4).default([]),
  indicators: z.record(indicatorSchema).default({}),
  rank_positions: z.record(z.number()).default({}),
  why: z.array(evidenceSchema).default([]),
  trade_offs: z.array(evidenceSchema).default([]),
  uncertainties: z.array(evidenceSchema).default([]),
  historical_vulnerabilities: z.array(vulnerabilitySchema).default([]),
  dominated_by: z.array(z.string()).default([]),
  missing: z.array(z.string()).default([]),
  status: statusSchema.optional()
}).passthrough();
export type RecommendationCandidate = z.infer<typeof recommendationCandidateSchema>;
export const recommendRequestSchema = z.object({
  location: locationSchema.optional(),
  location_id: z.string().optional(),
  field: fieldSchema.optional(),
  goals: goalsSchema.optional(),
  candidates: z.array(z.object({
    candidate_id: z.string(),
    label: z.string().nullable().optional(),
    plans: z.array(planSchema).min(1).max(4)
  })).optional()
});
export type RecommendRequest = z.infer<typeof recommendRequestSchema>;
export const recommendResponseSchema = z.object({
  meta,
  status: statusSchema,
  result_id: z.string().optional(),
  method: z.object({
    indicators_used: z.array(z.string()),
    weights: z.record(z.number()).optional(),
    note: z.string().optional(),
    ordering_text: z.string().optional()
  }).passthrough().optional(),
  shortlist: z.array(recommendationCandidateSchema).default([]),
  dominated: z.array(recommendationCandidateSchema).default([]),
  not_comparable: z.array(recommendationCandidateSchema).default([]),
  generation_log: z.array(logEntry).default([]),
  gaps: z.array(z.string()).default([]),
  reason_text: z.string().nullable().optional()
}).passthrough();
export type RecommendResponse = z.infer<typeof recommendResponseSchema>;
export const dateFields = ["prev_harvest", "next_plant", "winter.seed", "winter.terminate", "winter.plant", "winter.harvest"] as const;
export const editSchema = z.object({
  field: z.string(),
  season: z.number().int().min(1).max(4).optional(),
  value: z.union([z.string(), z.number(), z.null()]).optional(),
  shift_days: z.number().int().optional()
});
export type FutureEdit = z.infer<typeof editSchema>;
export const futureRequestSchema = z.object({
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
  }),
  candidate: generatedCandidateSchema.optional(),
  plan: planSchema.optional(),
  plans: z.array(planSchema).min(1).max(4).optional(),
  start_season: z.string().regex(/^\d{4}$/),
  seasons: z.number().int().min(1).max(4),
  edits: z.array(editSchema).optional(),
  priorities: z.record(z.enum(priorityIds), weight).optional()
}).refine(r => [r.candidate, r.plan, r.plans].filter(Boolean).length === 1, "Send one candidate, plan, or plans list");
export type FutureRequest = z.infer<typeof futureRequestSchema>;
export const futureWindowSchema = z.object({
  kind: z.string(),
  start: isoDate.nullable(),
  end: isoDate.nullable(),
  origin: originSchema,
  label: z.string().optional(),
  field: z.string().nullable().optional(),
  source: sourceSchema.nullable().optional()
}).passthrough();
const coverSchema = z.object({
  crop_id: z.string(),
  seed: isoDate,
  terminate: isoDate,
  living_cover_days: z.number().nullable().optional(),
  establishment: z.string().optional(),
  origin: z.object({
    seed: originSchema,
    terminate: originSchema
  })
}).passthrough();
export const futureSeasonSchema = z.object({
  season: z.string(),
  status: statusSchema.optional(),
  plan: planSchema.optional(),
  windows: z.array(futureWindowSchema).default([]),
  cover_schedule: coverSchema.nullable().optional(),
  milestones: z.array(z.object({
    date: isoDate,
    end_date: isoDate.nullable().optional(),
    label: z.string(),
    origin: originSchema,
    status: statusSchema.optional(),
    rule_origin: originSchema.nullable().optional()
  }).passthrough()).default([]),
  decision_deadlines: z.array(z.object({
    date: isoDate,
    decision: z.string(),
    switch_condition: z.string().nullable().optional(),
    next_check_date: isoDate.nullable().optional(),
    origin: originSchema.optional(),
    assumptions: z.array(z.string()).optional()
  }).passthrough()).default([]),
  warnings: z.array(z.union([z.string(), evidenceSchema])).default([]),
  historical_vulnerabilities: z.array(vulnerabilitySchema).default([]),
  explanations: z.array(evidenceSchema).default([]),
  backup: z.object({
    status: statusSchema.optional(),
    fallback_plan_id: z.string().nullable().optional(),
    switch_condition: z.object({
      text: z.string()
    }).passthrough().nullable().optional(),
    assumptions: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional()
  }).passthrough().nullable().optional(),
  notes: z.array(z.string()).default([])
}).passthrough();
export type FutureSeason = z.infer<typeof futureSeasonSchema>;
const diffChange = z.object({
  season: z.string().optional(),
  plan_edits: z.array(z.object({
    field: z.string(),
    before: z.unknown(),
    after: z.unknown()
  })).optional(),
  changes: z.array(z.object({
    label: z.string().optional(),
    label_after: z.string().optional(),
    action_id: z.string().optional(),
    change: z.string().optional(),
    date_before: z.string().nullable().optional(),
    date_after: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    why: z.array(z.string()).optional()
  }).passthrough()).optional(),
  decision_deadline: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    next_check_before: z.string().nullable().optional(),
    next_check_after: z.string().nullable().optional()
  }).nullable().optional(),
  window_changes: z.array(z.object({
    kind: z.string(),
    before: z.array(z.string().nullable()).nullable().optional(),
    after: z.array(z.string().nullable()).nullable().optional()
  })).optional()
}).passthrough();
export const futureResponseSchema = z.object({
  meta,
  status: statusSchema,
  seasons: z.array(futureSeasonSchema).default([]),
  note: z.string().optional(),
  reason_text: z.string().nullable().optional(),
  gaps: z.array(z.string()).default([]),
  diff: z.object({
    changes: z.array(diffChange)
  }).optional(),
  recommendation_refresh: z.object({
    status: statusSchema,
    reason_text: z.string().nullable().optional(),
    reason: z.string().optional(),
    indicators: z.record(indicatorSchema).nullable().optional(),
    method: z.object({
      indicators_used: z.array(z.string())
    }).passthrough().nullable().optional()
  }).passthrough().optional()
}).passthrough();
export type FutureResponse = z.infer<typeof futureResponseSchema>;
export class PlanningApiError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "PlanningApiError";
    this.httpStatus = httpStatus;
  }
}
async function post<T>(path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${(import.meta.env.VITE_API_BASE ?? "http://localhost:8000").replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PlanningApiError("The planning service returned an unreadable response.", response.status);
  }
  if (!response.ok) {
    const error = z.object({
      reason_text: z.string().nullable().optional(),
      issues: z.array(z.object({
        field: z.string(),
        message: z.string()
      })).optional()
    }).safeParse(payload);
    throw new PlanningApiError(error.success ? error.data.issues?.map(i => `${i.field}: ${i.message}`).join(" ") || error.data.reason_text || `Planning request failed (${response.status}).` : `Planning request failed (${response.status}).`, response.status);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new PlanningApiError("The planning response does not match the API contract. Please retry or check the service version.");
  return parsed.data;
}
export const generatePlans = (request: GenerateRequest, signal?: AbortSignal) => post("/v1/plans/generate", generateRequestSchema.parse(request), generateResponseSchema, signal);
export const recommendPlans = (request: RecommendRequest, signal?: AbortSignal) => post("/v1/plans/recommend", recommendRequestSchema.parse(request), recommendResponseSchema, signal);
export const fetchFuturePlan = (request: FutureRequest, signal?: AbortSignal) => post("/v1/plans/future", futureRequestSchema.parse(request), futureResponseSchema, signal);
export function fetchHistoricalReplay(request: ReplayRequest, signal?: AbortSignal) {
  const parsed = replaySchema.parse(request);
  if (!/^\/v1\/seasons\/\d{4}\/replay$/.test(parsed.path)) throw new PlanningApiError("This historical replay link is not supported.");
  return post(parsed.path, parsed.body, historicalReplaySchema, signal);
}
