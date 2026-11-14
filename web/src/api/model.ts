import type { z } from "zod";
import type { Plan, SpringWindow, Status, Threshold as ThresholdSchema } from "./schema";
export type { Status };
import type { Origin } from "../farm/types";

/*
  The model the global screens read (map entry, capabilities, farm and field analysis,
  regional profiles and research). adapt.ts builds these from the backend's responses
  (docs/global/contract.md §2–§7); nothing here knows a backend field name, and nothing
  here is computed in the browser. Missing values stay `null`.
*/

export type { Origin };
type Threshold = z.infer<typeof ThresholdSchema>;
export type JobStatus = "pending" | "ready" | "failed";
export type Hemisphere = "north" | "south";

export const ORIGINS: readonly Origin[] = [
  "nasa_measured",
  "nasa_modeled",
  "calculation",
  "verified_source",
  "source_checked",
  "ai_suggested",
  "grower",
  "assumed",
  "dataset_estimate",
];

export interface LatLon {
  latitude: number;
  longitude: number;
}

export interface SourceRef {
  title: string;
  url: string | null;
  locator: string | null;
}

// ------------------------------------------------------------------ geo (§3)
export interface GeoHit {
  label: string;
  point: LatLon;
  /** [west, south, east, north] or null for a bare coordinate. */
  bbox: [number, number, number, number] | null;
  kind: string;
}
export interface GeoSearch {
  queryKind: "text" | "coordinates";
  hits: GeoHit[];
}

export interface Climate {
  code: string;
  label: string;
  resolutionKm: number | null;
  source: string;
  origin: Origin;
}

export interface PlaceInfo {
  status: Status;
  reasonText: string | null;
  display: string | null;
  country: string | null;
  countryName: string | null;
  admin1: string | null;
  admin1Name: string | null;
  admin2Name: string | null;
  hemisphere: Hemisphere | null;
  onLand: boolean;
  climate: Climate | null;
  cellId: string | null;
  regionKeys: string[];
  ncRegion: string | null;
}

// ------------------------------------------------------------------ capabilities (§4)
export type CapabilityKey = "weather" | "catalog" | "soil" | "live_weather" | "drought" | "tools";
export const CAPABILITY_KEYS: readonly CapabilityKey[] = ["weather", "catalog", "soil", "live_weather", "drought", "tools"];

export interface Capability {
  key: CapabilityKey;
  /** `unknown` when the backend left the feature out. */
  status: Status;
  jobStatus: JobStatus | null;
  origin: Origin | null;
  provider: string | null;
  resolutionM: number | null;
  reasonText: string | null;
  /** Tools only: each tool's own status. */
  parts: Array<{ key: string; status: Status }>;
}
export interface Capabilities {
  regionKey: string | null;
  features: Capability[];
}

// ------------------------------------------------------------------ weather (§2)
export interface WeatherCoverage {
  firstDate: string | null;
  lastDate: string | null;
  completeYears: number | null;
  status: Status;
}
export interface WeatherCell {
  cellId: string | null;
  jobStatus: JobStatus;
  status: Status;
  reasonText: string | null;
  source: string | null;
  snapshotHash: string | null;
  retrievedAt: string | null;
  center: LatLon | null;
  sizeDeg: [number, number] | null;
  note: string | null;
  coverage: WeatherCoverage | null;
  poll: string | null;
}

// ------------------------------------------------------------------ farm analysis (§5)
export interface ValueWithOrigin<T = number | null> {
  value: T;
  unit: string;
  origin: Origin;
}

export interface FieldThresholds {
  heavyRain: (Threshold & { origin: Origin }) | null;
  drySpring: (Threshold & { origin: Origin }) | null;
  heavyRainMethod: string | null;
}

export interface RuleLine {
  ruleId: string;
  verdict: string;
  status: Status;
  text: string;
  origin: Origin;
  source: SourceRef | null;
  print: boolean;
}

export interface FieldPlanResult {
  plan: Plan;
  hemisphere: Hemisphere | null;
  /** Off-season wording from the backend ("Winter" in NC, "Off-season (May–Oct)" elsewhere). */
  seasonLabel: string | null;
  springLabel: string | null;
  thresholds: FieldThresholds;
  springWindow: SpringWindow | null;
  availableYears: number[];
  rules: RuleLine[];
}

export interface FieldAnalysis {
  fieldId: string;
  name: string;
  areaHa: number | null;
  areaAc: number | null;
  centroid: LatLon | null;
  cellId: string | null;
  jobStatus: JobStatus;
  /** The field's own status and reason (e.g. no weather yet), from the backend. */
  status: Status;
  reasonText: string | null;
  /** `nc` (NC rules apply) or `global`. */
  scope: string | null;
  poll: string | null;
  capabilities: Capability[] | null;
  result: FieldPlanResult | null;
}

export interface SharedCell {
  cellId: string;
  fieldIds: string[];
  note: string;
}

export interface FarmAnalysis {
  status: Status;
  requestId: string;
  fields: FieldAnalysis[];
  weatherCells: SharedCell[];
  /** Area is the only farm total; there is never a metric total. */
  totals: { areaHa: number | null; areaAc: number | null };
}

export interface InputIssue {
  field: string;
  code: string;
  message: string;
}

// ------------------------------------------------------------------ profile and research (§6)
export interface Window {
  start: string;
  end: string;
}
export interface ProfileCrop {
  cropId: string;
  name: string;
  roles: string[];
  calendar: { plant: Window | null; harvest: Window | null; origin: Origin; source: SourceRef | null } | null;
}
export interface ProfileCover {
  cropId: string;
  name: string;
  origin: Origin;
  sources: SourceRef[];
}
export interface ProfileRotation {
  label: string;
  origin: Origin;
  sources: SourceRef[];
}
export interface ProfileRule {
  ruleId: string;
  text: string;
  origin: Origin;
  evidenceQuote: string | null;
  source: SourceRef | null;
  conflictsWith: string[];
  limitations: string | null;
}
export interface RegionProfile {
  regionKey: string;
  status: Status;
  research: { jobStatus: JobStatus; generatedAt: string | null; model: string | null } | null;
  crops: ProfileCrop[];
  covers: ProfileCover[];
  rotations: ProfileRotation[];
  rules: ProfileRule[];
  gaps: string[];
  disclaimer: string | null;
}

export interface ResearchJob {
  jobId: string | null;
  jobStatus: JobStatus;
  regionKey: string;
  status: Status | null;
  reasonText: string | null;
  profileUrl: string | null;
}

// ------------------------------------------------------------------ goals, generation, recommendation, future (§8–§10)
export const PRIORITY_NAMES = [
  "soil_cover",
  "water_conservation",
  "weather_resilience",
  "crop_diversity",
  "living_cover_duration",
  "management_simplicity",
] as const;
export type PriorityName = (typeof PRIORITY_NAMES)[number];

/** Goals for one field (§8). `null` is "unknown", never false. */
export interface Goals {
  priorities: Partial<Record<PriorityName, number>>;
  constraints?: {
    allowedCrops?: string[] | null;
    excludedCrops?: string[];
    mustInclude?: string[];
    irrigation?: "yes" | "no" | "unknown";
    equipment?: string[];
    latestPlanting?: string | null;
    earliestHarvest?: string | null;
    seasons?: number | null;
  };
  preferences?: { likedCrops?: string[]; dislikedCrops?: string[] };
}

/** Where a planning request applies: a point, a cell, or (NC demo) a place id. */
export type PlanPlace = { point: LatLon } | { cellId: string } | { locationId: string };

export interface PlanningField {
  fieldId: string;
  areaHa: number | null;
  cropHistory: string[];
}

/** One season's plan in the backend's plan shape (passed back unchanged to replay/future). */
export type BackendPlanShape = Record<string, unknown> & { plan_id: string; label?: string | null };

export interface LogLine {
  kind: string;
  name: string;
  pruned: number | string | null;
  reasonText: string;
}

export interface Candidate {
  candidateId: string;
  label: string;
  crops: string[];
  seasons: Array<{ season: number; year: number | null; plan: BackendPlanShape }>;
  /** The origins that this candidate's dates and crops come from. */
  origins: Origin[];
  flaggedRuleIds: string[];
  manualCheckRuleIds: string[];
  /** The raw candidate, to send back to /v1/plans/future or /recommend unchanged. */
  raw: Record<string, unknown>;
}

export interface Generation {
  status: Status;
  reasonText: string | null;
  regionKey: string | null;
  candidates: Candidate[];
  log: LogLine[];
  gaps: string[];
}

export interface Indicator {
  name: string;
  value: number | null;
  unit: string | null;
  direction: "lower_better" | "higher_better" | null;
  origin: Origin;
  status: Status;
  definition: string | null;
  rationale: string | null;
  source: SourceRef | null;
  perLeg: Array<number | null>;
  inPriorities: boolean;
}

export interface ReplayRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface Option {
  candidateId: string;
  label: string;
  origin: string;
  plans: BackendPlanShape[];
  legStatus: Status[];
  indicators: Record<string, Indicator>;
  rankPositions: Record<string, number | null>;
  wins: string[];
  loses: string[];
  why: Array<{ indicator: string; text: string; source: SourceRef | null }>;
  tradeOffs: Array<{ versus: string; text: string; worseOn: Array<{ indicator: string; value: number | null; versusValue: number | null; inPriorities: boolean }> }>;
  uncertainties: Array<{ text: string; origin: Origin }>;
  vulnerabilities: Array<{ year: string; indicator: string; planId: string; value: number | null; text: string; replay: ReplayRequest | null }>;
  dominatedBy: string[];
  missing: string[];
}

export interface Recommendation {
  status: Status;
  resultId: string | null;
  hemisphere: Hemisphere | null;
  method: { indicatorsUsed: string[]; weights: Record<string, number>; orderingText: string | null; note: string | null } | null;
  shortlist: Option[];
  notComparable: Option[];
  dominated: Option[];
  log: LogLine[];
  gaps: string[];
  reasonText: string | null;
}

export interface FutureWindow {
  kind: string;
  start: string;
  end: string;
  label: string;
  origin: Origin;
  source: SourceRef | null;
  field: string | null;
}
export interface FutureSeason {
  season: string;
  status: Status;
  plan: BackendPlanShape | null;
  windows: FutureWindow[];
  milestones: Array<{ date: string; endDate: string | null; label: string; kind: string; flagged: boolean; origin: Origin; ruleIds: string[] }>;
  deadlines: Array<{ date: string; decision: string; switchCondition: string | null; nextCheckDate: string | null; ruleIds: string[] }>;
  explanations: Array<{ ruleId: string; text: string; status: Status; origin: Origin; source: SourceRef | null }>;
  warnings: string[];
  backup: { status: Status; fallbackPlanId: string | null; what: string | null } | null;
  notes: string[];
}
export interface FuturePlan {
  status: Status;
  startSeason: string | null;
  seasons: FutureSeason[];
  note: string | null;
  datesBasis: string | null;
  diff: Array<{ field: string; from: unknown; to: unknown; text: string | null }>;
}
