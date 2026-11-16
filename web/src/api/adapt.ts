import { z } from "zod";
import {
  CompareResponse,
  Meta,
  SensitivityResponse,
  Status,
  Threshold,
  YearsResponse,
  type Era,
  type Plan,
  type PlanInput,
  type ReplayResponse,
  type SpringWindow,
} from "./schema";
import {
  CAPABILITY_KEYS,
  type Capabilities,
  type Capability,
  type CapabilityKey,
  type FarmAnalysis,
  type FieldPlanResult,
  type GeoSearch,
  type InputIssue,
  type JobStatus,
  type Origin,
  type PlaceInfo,
  type RegionProfile,
  type ResearchJob,
  type SourceRef,
  type WeatherCell,
  type BackendPlanShape,
  type FuturePlan,
  type Generation,
  type Goals,
  type LogLine,
  type Option,
  type PlanningField,
  type PlanPlace,
  type Recommendation,
} from "./model";
import type { Farm, FieldPlan } from "../farm/types";
import {
  READING_KINDS,
  type Autofill,
  type CropJob,
  type CropOverride,
  type CropSearch,
  type DemoFarm,
  type Dist,
  type Economics,
  type LossAssumptions,
  type MoneyRef,
  type Odds,
  type Reading,
  type ReadingKind,
  type Scenario,
  type Simulation,
  type VocabItem,
} from "./simModel";

/*
  The boundary with Rahul's backend (Phase 12, backend branch at b51c804, Nov 14 2026).

  `Backend*` below are the real response shapes, field for field (docs/api/openapi.json and
  the generated examples). `adapt*` turns them into the model the screens were built on
  (schema.ts). Adapting only renames, selects and regroups values the backend already
  returned. It never computes a total, a rank, a count or a threshold.

  Since d7d3367 the compare and sensitivity responses carry everything the screens need:
  typical / dry / wet springs (`spring.shortcuts`), modeled soil wetness for each spring
  (`seasons[].gwet*_window_mean`), the springs each rye end date flags (`qualifying_years`),
  a plain sentence for each rule (`other_checks[].text`, `print`) and for each reason code
  (`reason_text`). The older sources (GET /v1/years, the saved wetness.json, the sweep's
  `dry_years`) are read only when a response from an older service leaves a value out.

  Since b51c804 every response is for one place (`location_id` or a point in the request,
  `weather_location` and that place's own thresholds in the answer). A plan compared outside
  the region its sample dates were assumed for carries a `region_note`.
*/

const md = z.string().regex(/^\d{2}-\d{2}$/, "expected MM-DD");
const int = z.number().int();

const BackendEraPart = z.object({ evaluable: int, events: int, pct: z.number().nullable() }).passthrough();
const BackendEra = z
  .object({ earlier: BackendEraPart, recent: BackendEraPart, diff_pp: z.number().nullable(), result: z.string(), caveat: z.string() })
  .passthrough();
type BackendEra = z.infer<typeof BackendEra>;

const BackendPlanDates = z
  .object({
    plan_id: z.string(),
    previous_crop_id: z.string(),
    prev_harvest: md,
    next_crop_id: z.string(),
    next_plant: md,
    winter: z
      .object({
        kind: z.enum(["none", "cover", "winter_grain"]),
        crop_id: z.string().nullable().optional(),
        seed: md.nullable().optional(),
        terminate: md.nullable().optional(),
        plant: md.nullable().optional(),
        harvest: md.nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const BackendSeason = z
  .object({
    year: int,
    spring_status: Status,
    spring_total_mm: z.number().nullable(),
    spring_rank: int.nullable(),
    spring_is_dry: z.boolean().nullable(),
    winter_status: Status,
    rain_outside_cover_mm: z.number().nullable(),
    // Modeled soil wetness over the same spring window as the replay; null when the window is incomplete.
    gwettop_window_mean: z.number().nullable().optional(),
    gwetroot_window_mean: z.number().nullable().optional(),
  })
  .passthrough();

const Shortcuts = z.object({ typical: int.nullable(), dry: int.nullable(), wet: int.nullable() }).passthrough();

const BackendPlan = z
  .object({
    plan_id: z.string(),
    label: z.string().nullable().optional(),
    status: Status,
    reason: z.string().nullable().optional(),
    // A plain sentence beside a reason that is a code (or the short form of a long one).
    reason_text: z.string().nullable().optional(),
    leg: z.union([z.literal(1), z.literal(2)]).nullable().optional(),
    rotation_id: z.string().nullable().optional(),
    editable: z.array(z.string()).nullable().optional(),
    dates_assumed: z.boolean().nullable().optional(),
    // At a place outside the region the sample dates were assumed for, the backend says so.
    region_note: z.string().nullable().optional(),
    plan: BackendPlanDates.nullable().optional(),
    calendar: z
      .object({
        living_cover_days_planned: int,
        days_without_planned_cover: int,
        termination_gap_days: int.nullable(),
        establishment: z.string(),
        spring_window: z.object({ start: md, end: md }).passthrough(),
      })
      .passthrough()
      .nullable()
      .optional(),
    winter: z
      .object({
        status: Status,
        eligible_seasons: int.optional(),
        segments: z.array(z.string()).default([]),
        per_season_median: z
          .object({ rain_mm_outside_cover: z.number().nullable(), heavy_rain_days_outside_cover: z.number().nullable() })
          .passthrough(),
      })
      .passthrough()
      .nullable()
      .optional(),
    spring: z
      .object({
        status: Status,
        median_total_mm: z.number().nullable(),
        dry_seasons: int.nullable(),
        eligible_seasons: int,
        // Typical, dry and wet springs for this plan's own planting date (so edited dates get them too).
        shortcuts: Shortcuts.nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    spring_checks: z
      .array(
        z
          .object({
            check_id: z.string(),
            rule_ids: z.array(z.string()),
            label: z.string().optional(),
            fires_when: z.string().optional(),
            count: int.nullable(),
            denominator: int.nullable(),
            pct: z.number().nullable(),
            qualifying_years: z.array(int),
            skipped_years: z.array(z.unknown()),
            source: z.object({ title: z.string(), url: z.string() }).passthrough().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    other_checks: z
      .array(
        z
          .object({
            rule_id: z.string(),
            verdict: z.string().nullable(),
            status: Status.optional(),
            reason: z.string(),
            // One sentence for the grower, and whether the line is worth a printed page.
            text: z.string().optional(),
            print: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    eras: z.record(BackendEra).default({}),
    seasons: z.array(BackendSeason).default([]),
    // A wheat double-crop plan also carries its own block (its dates and its own-window baseline).
    double_crop: z
      .object({ winter_exposure: z.object({ status: Status, reason: z.string().nullable().optional() }).passthrough().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
type BackendPlan = z.infer<typeof BackendPlan>;

export const BackendCompare = z
  .object({
    meta: Meta,
    request_echo: z.object({ location_id: z.string().nullable().optional() }).passthrough(),
    thresholds: z.object({ heavy_rain: Threshold, dry_spring: z.record(Threshold) }).passthrough(),
    // The real service lists the years; the draft examples gave only how many.
    shared_eligible_years: z.object({ spring: z.array(int), winter: z.array(int) }).passthrough(),
    plans: z.array(BackendPlan).min(1),
  })
  .passthrough();
export type BackendCompare = z.infer<typeof BackendCompare>;

export const BackendRotations = z
  .object({ rotations: z.array(z.object({ rotation_id: z.string(), label: z.string(), legs: z.array(z.string()).min(1) }).passthrough()) })
  .passthrough();
export type BackendRotations = z.infer<typeof BackendRotations>;

/** GET /v1/years?plan=…: the same shape the screens use, plus which plan's dates it was built on. */
export const BackendYears = YearsResponse.and(z.object({ plan_basis: z.object({ plan_id: z.string(), next_plant: md }).passthrough().optional() }));
export type BackendYears = z.infer<typeof BackendYears>;

export const BackendSensitivity = z
  .object({
    meta: Meta,
    base_plan_id: z.string(),
    varied: z.literal("terminate"),
    fixed: z.object({ next_plant: md, seed: md }).passthrough(),
    check_id: z.string(),
    denominator: int,
    dry_years: z.array(int).optional(),
    points: z
      .array(
        z
          .object({
            terminate: md,
            gap_days: int,
            living_cover_days_planned: int,
            rain_outside_cover_mm_median: z.number().nullable(),
            checks_count: int.nullable(),
            // The springs this end date would have flagged.
            qualifying_years: z.array(int).optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
export type BackendSensitivity = z.infer<typeof BackendSensitivity>;

const WetnessBlock = z.object({ gwettop_window_mean: z.number().nullable(), gwetroot_window_mean: z.number().nullable() }).passthrough();
/** wetness.json: plan id → year → the `wetness` block of that season's replay. */
export const SavedWetness = z.record(z.record(WetnessBlock.nullable()));
export type SavedWetness = z.infer<typeof SavedWetness>;

/** GET /v1/seasons/{year}/replay: daily rows carry `in_spring_window`. */
const BackendReplayDay = z.object({ in_spring_window: z.boolean().optional() }).passthrough();

// ------------------------------------------------------------------ helpers

const VERDICTS = ["preferred", "acceptable", "caution", "avoid", "manual_check", "unknown", "inapplicable"] as const;
type Verdict = (typeof VERDICTS)[number];
const asVerdict = (v: string | null | undefined, status: string | undefined): Verdict =>
  (VERDICTS as readonly string[]).includes(v ?? "") ? (v as Verdict) : (VERDICTS as readonly string[]).includes(status ?? "") ? (status as Verdict) : "unknown";

const ERA_RESULTS = ["more_frequent_recent", "less_frequent_recent", "similar", "insufficient_data"] as const;
function era(e: BackendEra): Era {
  return {
    ...e,
    earlier: { ...e.earlier, count: e.earlier.events, denominator: e.earlier.evaluable, pct: e.earlier.pct },
    recent: { ...e.recent, count: e.recent.events, denominator: e.recent.evaluable, pct: e.recent.pct },
    diff_pp: e.diff_pp,
    result: (ERA_RESULTS as readonly string[]).includes(e.result) ? (e.result as Era["result"]) : "insufficient_data",
    caveat: e.caveat,
  };
}

/** One spring window per planting date. The id is only a key the screens use to look it up. */
export const windowId = (plant: string) => `plant_${plant}`;

const CROP_LABEL: Record<string, string> = { soybean: "soybean", field_corn: "corn", maize: "maize" };

function plan(p: BackendPlan): Plan {
  const d = p.plan ?? null;
  const w = d?.winter;
  const sequence = d
    ? {
        previous_crop_id: d.previous_crop_id,
        prev_harvest: d.prev_harvest,
        next_crop_id: d.next_crop_id,
        next_plant: d.next_plant,
        winter:
          w?.kind === "cover" && w.crop_id && w.seed && w.terminate
            ? ({ type: "cover", crop_id: w.crop_id, seed: w.seed, terminate: w.terminate } as const)
            : w?.kind === "winter_grain" && w.crop_id && w.plant && w.harvest
              ? ({ type: "winter_grain", crop_id: w.crop_id, plant: w.plant, harvest: w.harvest } as const)
              : ({ type: "none" } as const),
      }
    : undefined;
  return {
    plan_id: p.plan_id,
    label: p.label ?? p.plan_id,
    rotation_id: p.rotation_id ?? undefined,
    leg: p.leg ?? undefined,
    status: p.status,
    // The backend's plain sentence when it gives one; with no winter figure, its words for that figure.
    reason: p.reason_text || (!p.winter && p.double_crop?.winter_exposure?.reason) || p.reason || undefined,
    double_crop: p.double_crop ?? undefined,
    editable: p.editable ?? undefined,
    dates_assumed: p.dates_assumed ?? undefined,
    region_note: p.region_note ?? undefined,
    sequence,
    spring_window: p.calendar ? { start: p.calendar.spring_window.start, end: p.calendar.spring_window.end } : undefined,
    spring_window_id: d ? windowId(d.next_plant) : undefined,
    calendar: p.calendar
      ? {
          living_cover_days_planned: p.calendar.living_cover_days_planned,
          days_without_planned_cover: p.calendar.days_without_planned_cover,
          termination_gap_days: p.calendar.termination_gap_days,
          establishment: p.calendar.establishment,
        }
      : undefined,
    winter: p.winter
      ? {
          status: p.winter.status,
          eligible_seasons: p.winter.eligible_seasons,
          segments: p.winter.segments,
          per_season_median: {
            rain_mm_without_cover: p.winter.per_season_median.rain_mm_outside_cover,
            heavy_rain_days_without_cover: p.winter.per_season_median.heavy_rain_days_outside_cover,
          },
          per_season: p.seasons.map((s) => ({ year: s.year, rain_mm_without_cover: s.rain_outside_cover_mm, status: s.winter_status })),
        }
      : undefined,
    spring_checks: p.spring_checks.map((c) => ({ ...c, source: c.source ?? undefined })),
    other_checks: p.other_checks.map((c) => ({ ...c, verdict: asVerdict(c.verdict, c.status) })),
    eras: Object.fromEntries(Object.entries(p.eras).map(([k, e]) => [k, era(e)])),
  };
}

/** Fallback values for a response from an older service, keyed by planting date (MM-DD). */
export interface CompareExtras {
  rotations?: BackendRotations | null;
  /** Shortcut years per planting date, from GET /v1/years for a plan with that date. */
  shortcuts?: Record<string, { typical: number | null; dry: number | null; wet: number | null }>;
  wetness?: SavedWetness | null;
}

/** Shortcut years keyed by the planting date each /v1/years answer was built on. */
export function shortcutsByPlant(years: Array<BackendYears | null | undefined>): NonNullable<CompareExtras["shortcuts"]> {
  const out: NonNullable<CompareExtras["shortcuts"]> = {};
  for (const y of years) if (y?.plan_basis) out[y.plan_basis.next_plant] = y.shortcuts;
  return out;
}

/** One planting date's spring window: its cutoff, its springs and its dry-spring eras, as returned. */
function springWindow(p: BackendPlan, threshold: z.infer<typeof Threshold> | undefined, extras: CompareExtras = {}): SpringWindow | null {
  const d = p.plan;
  if (!d || !p.calendar || !p.spring) return null;
  const dry = p.eras["dry_spring"];
  if (!threshold || !dry) return null;
  const wet = extras.wetness?.[p.plan_id];
  const of = p.spring.eligible_seasons;
  const id = windowId(d.next_plant);
  return {
    id,
    label: `The 30 days before ${CROP_LABEL[d.next_crop_id] ?? "the next crop's"} planting`,
    plant: d.next_plant,
    start: p.calendar.spring_window.start,
    end: p.calendar.spring_window.end,
    threshold,
    median_mm: p.spring.median_total_mm,
    dry_count: p.spring.dry_seasons,
    denominator: of,
    shortcuts: p.spring.shortcuts ?? extras.shortcuts?.[d.next_plant] ?? { typical: null, dry: null, wet: null },
    years: p.seasons.map((s) => ({
      year: s.year,
      start: `${s.year}-${p.calendar!.spring_window.start}`,
      end: `${s.year}-${p.calendar!.spring_window.end}`,
      total_mm: s.spring_total_mm,
      status: s.spring_status,
      rank: s.spring_rank,
      of: s.spring_rank === null ? null : of,
      percentile: null,
      is_dry: s.spring_is_dry,
      gwettop_window_mean: s.gwettop_window_mean !== undefined ? s.gwettop_window_mean : (wet?.[String(s.year)]?.gwettop_window_mean ?? null),
      gwetroot_window_mean: s.gwetroot_window_mean !== undefined ? s.gwetroot_window_mean : (wet?.[String(s.year)]?.gwetroot_window_mean ?? null),
    })),
    eras: { dry_spring: era(dry) },
  };
}

export function adaptCompare(real: BackendCompare, extras: CompareExtras = {}): CompareResponse {
  const windows: Record<string, SpringWindow> = {};
  for (const p of real.plans) {
    const d = p.plan;
    if (!d) continue;
    const id = windowId(d.next_plant);
    if (windows[id]) continue;
    const w = springWindow(p, real.thresholds.dry_spring[d.next_plant], extras);
    if (w) windows[id] = w;
  }
  const first = real.plans.find((p) => p.plan)?.plan?.next_plant;
  const out = {
    ...real,
    request_echo: { ...real.request_echo, location_id: real.request_echo.location_id ?? "custom" },
    shared_eligible_years: {
      ...real.shared_eligible_years,
      spring: real.shared_eligible_years.spring.length,
      winter: real.shared_eligible_years.winter.length,
      spring_years: real.shared_eligible_years.spring,
      winter_years: real.shared_eligible_years.winter,
    },
    thresholds: {
      ...real.thresholds,
      heavy_rain: real.thresholds.heavy_rain,
      // The screens read one cutoff at a time; the view builder swaps in the selected window's own.
      dry_spring: (first && real.thresholds.dry_spring[first]) ?? Object.values(real.thresholds.dry_spring)[0] ?? { value: null, unit: "mm", method: "not available", status: "unavailable" as const },
      dry_spring_by_plant: real.thresholds.dry_spring,
    },
    plans: real.plans.map(plan),
    rotations: (extras.rotations?.rotations ?? []).map((r) => ({
      rotation_id: r.rotation_id,
      label: r.label,
      legs: r.legs.slice(0, 2).map((plan_id, i) => ({ leg: (i + 1) as 1 | 2, plan_id })),
    })),
    spring_windows: windows,
  };
  // The adapted object must satisfy the model the screens were built on.
  return CompareResponse.parse(out);
}

export function adaptSensitivity(real: BackendSensitivity): SensitivityResponse {
  const dry = real.dry_years;
  return SensitivityResponse.parse({
    ...real,
    points: real.points.map((p) => ({
      ...p,
      rain_mm_without_cover_median: p.rain_outside_cover_mm_median,
      // The point's own list. An older service gave only the sweep's dry springs: use that list
      // just when the point's count says every one of them is flagged, else leave the years unknown.
      qualifying_years: p.qualifying_years ?? (p.checks_count === 0 ? [] : dry && p.checks_count === dry.length ? dry : undefined),
    })),
  });
}

/** Keeps the days inside the 30-day planting window, which is what the evidence table lists. */
export function adaptReplay(r: ReplayResponse): ReplayResponse {
  const days = r.daily.filter((d) => BackendReplayDay.parse(d).in_spring_window !== false);
  return days.length === r.daily.length ? r : { ...r, daily: days, daily_scope: "spring_window" };
}

/** The request body for POST /v1/plans/compare: the backend's plan fields (`winter.kind`, `grower`). */
export function toBackendPlan(p: PlanInput) {
  const w = p.winter;
  return {
    plan_id: p.plan_id,
    previous_crop_id: p.previous_crop_id,
    prev_harvest: p.prev_harvest,
    next_crop_id: p.next_crop_id,
    next_plant: p.next_plant,
    winter:
      w.type === "cover"
        ? { kind: "cover", crop_id: w.crop_id, seed: w.seed, terminate: w.terminate }
        : w.type === "winter_grain"
          ? { kind: "winter_grain", crop_id: w.crop_id, plant: w.plant, harvest: w.harvest }
          : { kind: "none" },
    grower: { low_moisture_concern: p.low_moisture_concern === "yes" ? true : p.low_moisture_concern === "no" ? false : null },
  };
}

// ================================================================== global endpoints (D1)
/*
  docs/global/contract.md §2–§7. Backend shapes are parsed tolerantly (passthrough, optional
  extras) and turned into the model in model.ts. A missing value becomes null, never 0; a
  missing status becomes "unknown"; a missing origin is never upgraded to a verified one.
*/

const OriginZ = z.enum([
  "nasa_measured",
  "nasa_modeled",
  "calculation",
  "verified_source",
  "source_checked",
  "ai_suggested",
  "grower",
  "assumed",
  "dataset_estimate",
]);
const JobZ = z.enum(["pending", "ready", "failed"]);
const num = z.number().nullable().optional();
const str = z.string().nullable().optional();
const LooseStatus = z.string().nullable().optional();
const asStatus = (s: string | null | undefined): Status => (Status.options as readonly string[]).includes(s ?? "") ? (s as Status) : "unknown";
/** An origin the backend left out or misspelled is shown as an unconfirmed AI suggestion, never as verified. */
const asOrigin = (o: string | null | undefined, fallback: Origin = "ai_suggested"): Origin =>
  (OriginZ.options as readonly string[]).includes(o ?? "") ? (o as Origin) : fallback;
const asJob = (j: string | null | undefined, fallback: JobStatus): JobStatus => (JobZ.options as readonly string[]).includes(j ?? "") ? (j as JobStatus) : fallback;
const nn = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

const BackendPoint = z.object({ latitude: z.number(), longitude: z.number() }).passthrough();
const BackendSource = z.object({ title: z.string().nullable().optional(), url: str, locator: str }).passthrough();
const source = (s: z.infer<typeof BackendSource> | null | undefined): SourceRef | null =>
  s ? { title: s.title ?? s.url ?? "Source", url: nn(s.url), locator: nn(s.locator) } : null;

// ------------------------------------------------------------------ §3 geo
export const BackendGeoSearch = z
  .object({
    query_kind: z.string().optional(),
    results: z
      .array(
        z
          .object({ label: z.string(), latitude: z.number(), longitude: z.number(), bbox: z.array(z.number()).length(4).nullable().optional(), kind: z.string().optional() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export function adaptGeoSearch(r: z.infer<typeof BackendGeoSearch>): GeoSearch {
  return {
    queryKind: r.query_kind === "coordinates" ? "coordinates" : "text",
    hits: r.results.map((h) => ({
      label: h.label,
      point: { latitude: h.latitude, longitude: h.longitude },
      bbox: h.bbox ? (h.bbox as [number, number, number, number]) : null,
      kind: h.kind ?? "place",
    })),
  };
}

export const BackendReverse = z
  .object({
    status: LooseStatus,
    reason_text: str,
    place: z
      .object({ display: str, country: str, country_name: str, admin1: str, admin1_name: str, admin2_name: str })
      .passthrough()
      .nullable()
      .optional(),
    hemisphere: z.enum(["north", "south"]).nullable().optional(),
    on_land: z.boolean().optional(),
    climate: z
      .object({ koppen: z.string(), label: z.string().optional(), resolution_km: num, source: z.string().optional(), origin: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
    cell_id: str,
    region_keys: z.array(z.string()).default([]),
    nc_region: str,
  })
  .passthrough();
export function adaptReverse(r: z.infer<typeof BackendReverse>): PlaceInfo {
  const p = r.place ?? null;
  return {
    status: asStatus(r.status),
    reasonText: nn(r.reason_text),
    display: nn(p?.display),
    country: nn(p?.country),
    countryName: nn(p?.country_name),
    admin1: nn(p?.admin1),
    admin1Name: nn(p?.admin1_name),
    admin2Name: nn(p?.admin2_name),
    hemisphere: nn(r.hemisphere),
    onLand: r.on_land ?? false,
    climate: r.climate
      ? {
          code: r.climate.koppen,
          label: r.climate.label ?? r.climate.koppen,
          resolutionKm: nn(r.climate.resolution_km),
          source: r.climate.source ?? "",
          origin: asOrigin(r.climate.origin, "dataset_estimate"),
        }
      : null,
    cellId: nn(r.cell_id),
    regionKeys: r.region_keys,
    ncRegion: nn(r.nc_region),
  };
}

// ------------------------------------------------------------------ §4 capabilities
const BackendFeature = z
  .object({ status: LooseStatus, job_status: str, origin: str, provider: str, resolution_m: num, reason_text: str, reason: str, cell_id: str })
  .passthrough();
const BackendFeatures = z.record(z.unknown());
export const BackendCapabilities = z.object({ region_key: str, features: BackendFeatures.default({}) }).passthrough();

function feature(key: CapabilityKey, raw: unknown): Capability {
  if (key === "tools" && raw && typeof raw === "object") {
    const parts = Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => ({ key: k, status: asStatus(v as string) }));
    const statuses = parts.map((p) => p.status);
    // The tools block has no status of its own; it is complete only when every tool says so (a selection, not a calculation).
    const status: Status = parts.length === 0 ? "unknown" : statuses.every((s) => s === "complete") ? "complete" : statuses.some((s) => s === "complete" || s === "partial") ? "partial" : (statuses[0] ?? "unknown");
    return { key, status, jobStatus: null, origin: null, provider: null, resolutionM: null, reasonText: null, parts };
  }
  const f = BackendFeature.safeParse(raw);
  if (!f.success) return { key, status: "unknown", jobStatus: null, origin: null, provider: null, resolutionM: null, reasonText: "Not reported by the service.", parts: [] };
  const v = f.data;
  return {
    key,
    status: asStatus(v.status),
    jobStatus: v.job_status ? asJob(v.job_status, "pending") : null,
    origin: v.origin ? asOrigin(v.origin) : null,
    provider: nn(v.provider),
    resolutionM: nn(v.resolution_m),
    reasonText: nn(v.reason_text),
    parts: [],
  };
}
function features(raw: Record<string, unknown>): Capability[] {
  return CAPABILITY_KEYS.map((k) => feature(k, raw[k]));
}
export function adaptCapabilities(r: z.infer<typeof BackendCapabilities>): Capabilities {
  return { regionKey: nn(r.region_key), features: features(r.features) };
}

// ------------------------------------------------------------------ §2 weather
export const BackendWeather = z
  .object({
    cell_id: str,
    job_status: str,
    status: LooseStatus,
    reason_text: str,
    reason: str,
    source: str,
    snapshot_hash: str,
    retrieved_at: str,
    poll: str,
    cell: z
      .object({ center: BackendPoint.optional(), size_deg: z.array(z.number()).length(2).optional(), note: str })
      .passthrough()
      .nullable()
      .optional(),
    coverage: z
      .object({ first_date: str, last_date: str, complete_years: num, status: LooseStatus })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export function adaptWeather(r: z.infer<typeof BackendWeather>): WeatherCell {
  return {
    cellId: nn(r.cell_id),
    jobStatus: asJob(r.job_status, "failed"),
    status: asStatus(r.status),
    reasonText: nn(r.reason_text) ?? (r.reason ? r.reason.replace(/_/g, " ") : null),
    source: nn(r.source),
    snapshotHash: nn(r.snapshot_hash),
    retrievedAt: nn(r.retrieved_at),
    center: r.cell?.center ? { latitude: r.cell.center.latitude, longitude: r.cell.center.longitude } : null,
    sizeDeg: r.cell?.size_deg ? (r.cell.size_deg as [number, number]) : null,
    note: nn(r.cell?.note),
    coverage: r.coverage
      ? { firstDate: nn(r.coverage.first_date), lastDate: nn(r.coverage.last_date), completeYears: nn(r.coverage.complete_years), status: asStatus(r.coverage.status) }
      : null,
    poll: nn(r.poll),
  };
}

// ------------------------------------------------------------------ §5 farm analyze
const BackendThresholdOrigin = Threshold.and(z.object({ origin: str, method: z.string() }).passthrough());
const BackendFieldResult = BackendPlan.and(
  z
    .object({
      hemisphere: z.enum(["north", "south"]).nullable().optional(),
      season_label: str,
      winter: z.object({ season_label: str }).passthrough().nullable().optional(),
      spring: z.object({ season_label: str }).passthrough().nullable().optional(),
      thresholds: z
        .object({ heavy_rain: BackendThresholdOrigin.nullable().optional(), dry_spring: z.record(BackendThresholdOrigin).nullable().optional() })
        .passthrough()
        .nullable()
        .optional(),
      coverage: z.object({ available_years: z.array(int).default([]) }).passthrough().nullable().optional(),
    })
    .passthrough(),
);
/** The rule lines with the fields A2/B2 add to each one (`origin`, `source`). */
const BackendRuleLines = z
  .object({
    other_checks: z
      .array(
        z
          .object({ rule_id: z.string(), verdict: z.string().nullable().optional(), status: str, text: str, reason: z.string().default(""), print: z.boolean().optional(), origin: str, source: BackendSource.nullable().optional() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
const BackendField = z
  .object({
    field_id: z.string(),
    name: z.string().optional(),
    area_ha: num,
    area_ac: num,
    centroid: BackendPoint.nullable().optional(),
    cell_id: str,
    job_status: str,
    status: LooseStatus,
    reason_text: str,
    scope: str,
    poll: str,
    capabilities: z.record(z.unknown()).nullable().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();
/** Global responses: a farm or plan can span several snapshots, so `snapshot_hash` may be null. */
const GlobalMeta = z.object({ request_id: z.string().default(""), snapshot_hash: z.string().nullable().optional() }).passthrough();
export const BackendFarmAnalysis = z
  .object({
    meta: GlobalMeta,
    status: LooseStatus,
    fields: z.array(BackendField).default([]),
    weather_cells: z
      .array(
        z
          .object({
            cell_id: z.string(),
            field_ids: z.array(z.string()),
            note: z.string().optional(),
            cell: z.object({ center: BackendPoint.nullable().optional(), size_deg: z.tuple([z.number(), z.number()]).nullable().optional() }).passthrough().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    totals: z.object({ area_ha: num, area_ac: num }).passthrough().nullable().optional(),
  })
  .passthrough();
export const BackendIssues = z
  .object({ issues: z.array(z.object({ field: z.string().default(""), code: z.string().default("invalid_input"), message: z.string() }).passthrough()).default([]) })
  .passthrough();
export const adaptIssues = (r: z.infer<typeof BackendIssues>): InputIssue[] => r.issues.map((i) => ({ field: i.field, code: i.code, message: i.message }));

const SHARED_CELL_NOTE = "These fields share one NASA weather series; differences between them come from their plans, not their weather.";

function fieldResult(raw: unknown): FieldPlanResult | null {
  if (raw === null || raw === undefined) return null;
  const r = BackendFieldResult.parse(raw);
  const plant = r.plan?.next_plant;
  const dry = plant ? r.thresholds?.dry_spring?.[plant] : undefined;
  const heavy = r.thresholds?.heavy_rain ?? null;
  return {
    plan: plan(r),
    hemisphere: nn(r.hemisphere),
    seasonLabel: nn(r.winter?.season_label) ?? nn(r.season_label),
    springLabel: nn(r.spring?.season_label),
    thresholds: {
      heavyRain: heavy ? { ...heavy, origin: asOrigin(heavy.origin, "calculation") } : null,
      drySpring: dry ? { ...dry, origin: asOrigin(dry.origin, "calculation") } : null,
      heavyRainMethod: heavy?.method ?? null,
    },
    springWindow: springWindow(r, dry),
    availableYears: r.coverage?.available_years ?? [],
    rules: BackendRuleLines.parse(raw).other_checks.map((c) => ({
      ruleId: c.rule_id,
      verdict: asVerdict(c.verdict, c.status ?? undefined),
      status: asStatus(c.status),
      text: c.text || c.reason,
      origin: asOrigin(c.origin),
      source: source(c.source),
      print: c.print ?? false,
    })),
  };
}

export function adaptFarmAnalysis(r: z.infer<typeof BackendFarmAnalysis>): FarmAnalysis {
  return {
    status: asStatus(r.status),
    requestId: r.meta.request_id,
    fields: r.fields.map((f) => ({
      fieldId: f.field_id,
      name: f.name ?? f.field_id,
      areaHa: nn(f.area_ha),
      areaAc: nn(f.area_ac),
      centroid: f.centroid ? { latitude: f.centroid.latitude, longitude: f.centroid.longitude } : null,
      cellId: nn(f.cell_id),
      jobStatus: asJob(f.job_status, f.result ? "ready" : "pending"),
      status: asStatus(f.status),
      reasonText: nn(f.reason_text),
      scope: nn(f.scope),
      poll: nn(f.poll),
      capabilities: f.capabilities ? features(f.capabilities) : null,
      result: fieldResult(f.result),
    })),
    weatherCells: r.weather_cells.map((c) => ({
      cellId: c.cell_id,
      fieldIds: c.field_ids,
      note: c.note ?? SHARED_CELL_NOTE,
      center: c.cell?.center ? { latitude: c.cell.center.latitude, longitude: c.cell.center.longitude } : null,
      sizeDeg: c.cell?.size_deg ?? null,
    })),
    totals: { areaHa: nn(r.totals?.area_ha), areaAc: nn(r.totals?.area_ac) },
  };
}

/** The request body for POST /v1/farms/analyze. Field plans are already in the backend's plan shape (farm/types.ts). */
export function toBackendFarm(farm: Farm, options: { includeSoil?: boolean; prepareWeather?: boolean } = {}) {
  return {
    farm: {
      farm_id: farm.farm_id,
      name: farm.name,
      fields: farm.fields
        .filter((f) => f.plan)
        .map((f) => ({
          field_id: f.field_id,
          name: f.name,
          geometry: f.geometry,
          plan: {
            plan_id: f.plan!.plan_id,
            previous_crop_id: f.plan!.previous_crop_id,
            next_crop_id: f.plan!.next_crop_id,
            prev_harvest: f.plan!.prev_harvest,
            next_plant: f.plan!.next_plant,
            winter: f.plan!.winter,
            grower: { low_moisture_concern: f.plan!.grower?.low_moisture_concern ?? null },
          },
        })),
    },
    options: { include_soil: options.includeSoil ?? true, prepare_weather: options.prepareWeather ?? true },
  };
}

// ------------------------------------------------------------------ §6 profile and research
const BackendWindow = z.object({ start: md, end: md }).passthrough();
export const BackendProfile = z
  .object({
    region_key: z.string(),
    status: LooseStatus,
    research: z.object({ job_status: str, generated_at: str, model: str }).passthrough().nullable().optional(),
    crops: z
      .array(
        z
          .object({
            crop_id: z.string(),
            name: z.string().optional(),
            roles: z.array(z.string()).default([]),
            calendar: z
              .object({ plant: BackendWindow.nullable().optional(), harvest: BackendWindow.nullable().optional(), origin: str, source: BackendSource.nullable().optional() })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
    cover_crops: z.array(z.object({ crop_id: z.string(), name: z.string().optional(), origin: str, sources: z.array(BackendSource).default([]) }).passthrough()).default([]),
    rotations: z.array(z.object({ label: z.string(), origin: str, sources: z.array(BackendSource).default([]) }).passthrough()).default([]),
    rules: z
      .array(
        z
          .object({
            rule_id: z.string(),
            text: z.string(),
            origin: str,
            evidence_quote: str,
            source: BackendSource.nullable().optional(),
            conflicts_with: z.array(z.string()).default([]),
            limitations: str,
          })
          .passthrough(),
      )
      .default([]),
    gaps: z.array(z.string()).default([]),
    disclaimer: str,
  })
  .passthrough();
const cropName = (id: string) => id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
export function adaptProfile(r: z.infer<typeof BackendProfile>): RegionProfile {
  return {
    regionKey: r.region_key,
    status: asStatus(r.status),
    research: r.research ? { jobStatus: asJob(r.research.job_status, "failed"), generatedAt: nn(r.research.generated_at), model: nn(r.research.model) } : null,
    crops: r.crops.map((c) => ({
      cropId: c.crop_id,
      name: c.name ?? cropName(c.crop_id),
      roles: c.roles,
      calendar: c.calendar
        ? { plant: nn(c.calendar.plant), harvest: nn(c.calendar.harvest), origin: asOrigin(c.calendar.origin, "dataset_estimate"), source: source(c.calendar.source) }
        : null,
    })),
    covers: r.cover_crops.map((c) => ({ cropId: c.crop_id, name: c.name ?? cropName(c.crop_id), origin: asOrigin(c.origin), sources: c.sources.map((s) => source(s)!) })),
    rotations: r.rotations.map((x) => ({ label: x.label, origin: asOrigin(x.origin), sources: x.sources.map((s) => source(s)!) })),
    rules: r.rules.map((x) => ({
      ruleId: x.rule_id,
      text: x.text,
      origin: asOrigin(x.origin),
      evidenceQuote: nn(x.evidence_quote),
      source: source(x.source),
      conflictsWith: x.conflicts_with,
      limitations: nn(x.limitations),
    })),
    gaps: r.gaps,
    disclaimer: nn(r.disclaimer),
  };
}

export const BackendResearch = z
  .object({ job_id: str, job_status: str, region_key: z.string(), status: LooseStatus, reason_text: str, reason: str, profile_url: str })
  .passthrough();
export function adaptResearch(r: z.infer<typeof BackendResearch>): ResearchJob {
  return {
    jobId: nn(r.job_id),
    jobStatus: asJob(r.job_status, "failed"),
    regionKey: r.region_key,
    status: r.status ? asStatus(r.status) : null,
    reasonText: nn(r.reason_text) ?? (r.reason ? r.reason.replace(/_/g, " ") : null),
    profileUrl: nn(r.profile_url),
  };
}

// ------------------------------------------------------------------ §8–§10 goals, generate, recommend, future
const BackendLog = z.array(z.object({ kind: str, name: str, rule: str, constraint: str, pruned: z.union([z.number(), z.string()]).nullable().optional(), reason_text: str }).passthrough()).default([]);
const adaptLog = (l: z.infer<typeof BackendLog>): LogLine[] =>
  l.map((x) => ({ kind: x.kind ?? (x.rule ? "rule" : "constraint"), name: x.name ?? x.rule ?? x.constraint ?? "", pruned: nn(x.pruned), reasonText: x.reason_text ?? "" }));
const PlanShape = z.object({ plan_id: z.string(), label: str }).passthrough();

const BackendCandidate = z
  .object({
    candidate_id: z.string(),
    label: str,
    crops: z.array(z.string()).default([]),
    seasons: z.array(z.object({ season: int, year: int.nullable().optional(), plan: PlanShape }).passthrough()).default([]),
    origins: z.union([z.array(z.string()), z.record(z.string())]).default([]),
    checks_summary: z.object({ flagged: z.array(z.string()).default([]), manual_check: z.array(z.string()).default([]) }).passthrough().nullable().optional(),
  })
  .passthrough();
export const BackendGeneration = z
  .object({ meta: GlobalMeta.optional(), status: LooseStatus, reason_text: str, region_key: str, candidates: z.array(BackendCandidate).default([]), generation_log: BackendLog, gaps: z.array(z.string()).default([]) })
  .passthrough();
export function adaptGeneration(r: z.infer<typeof BackendGeneration>): Generation {
  return {
    status: asStatus(r.status),
    reasonText: nn(r.reason_text),
    regionKey: nn(r.region_key),
    candidates: r.candidates.map((c) => ({
      candidateId: c.candidate_id,
      label: c.label ?? c.candidate_id,
      crops: c.crops,
      seasons: c.seasons.map((s) => ({ season: s.season, year: nn(s.year), plan: s.plan as BackendPlanShape })),
      origins: Array.isArray(c.origins) ? c.origins.map((o) => asOrigin(o, "assumed")) : [...new Set(Object.values(c.origins).map((o) => asOrigin(o, "assumed")))],
      flaggedRuleIds: c.checks_summary?.flagged ?? [],
      manualCheckRuleIds: c.checks_summary?.manual_check ?? [],
      raw: c as Record<string, unknown>,
    })),
    log: adaptLog(r.generation_log),
    gaps: r.gaps,
  };
}

const BackendIndicator = z
  .object({
    value: num,
    unit: str,
    direction: str,
    origin: str,
    status: LooseStatus,
    definition: str,
    rationale: str,
    source: BackendSource.nullable().optional(),
    per_leg: z.array(z.unknown()).default([]),
    in_priorities: z.boolean().optional(),
  })
  .passthrough();
const BackendOption = z
  .object({
    candidate_id: z.string(),
    label: str,
    origin: str,
    plans: z.array(PlanShape).default([]),
    leg_status: z.array(z.string()).default([]),
    indicators: z.record(BackendIndicator).default({}),
    rank_positions: z.record(z.unknown()).default({}),
    wins: z.array(z.string()).default([]),
    loses: z.array(z.string()).default([]),
    why: z.array(z.object({ indicator: z.string(), text: z.string(), source: BackendSource.nullable().optional() }).passthrough()).default([]),
    trade_offs: z
      .array(
        z
          .object({
            versus: z.string(),
            text: z.string(),
            worse_on: z.array(z.object({ indicator: z.string(), value: num, versus_value: num, in_priorities: z.boolean().optional() }).passthrough()).default([]),
          })
          .passthrough(),
      )
      .default([]),
    uncertainties: z.array(z.object({ text: z.string(), origin: str }).passthrough()).default([]),
    historical_vulnerabilities: z
      .array(
        z
          .object({ year: z.union([z.string(), z.number()]), indicator: z.string(), plan_id: z.string().default(""), value: num, text: z.string().default(""), replay: z.object({ method: z.string(), path: z.string(), body: z.record(z.unknown()) }).passthrough().nullable().optional() })
          .passthrough(),
      )
      .default([]),
    dominated_by: z.array(z.string()).default([]),
    missing: z.array(z.string()).default([]),
  })
  .passthrough();
export const BackendRecommendation = z
  .object({
    meta: GlobalMeta.optional(),
    status: LooseStatus,
    result_id: str,
    hemisphere: z.enum(["north", "south"]).nullable().optional(),
    method: z.object({ indicators_used: z.array(z.string()).default([]), weights: z.record(z.unknown()).default({}), ordering_text: str, note: str }).passthrough().nullable().optional(),
    shortlist: z.array(BackendOption).default([]),
    not_comparable: z.array(BackendOption).default([]),
    dominated: z.array(BackendOption).default([]),
    generation_log: BackendLog,
    gaps: z.array(z.string()).default([]),
    reason_text: str,
  })
  .passthrough();
const perLegValue = (v: unknown): number | null =>
  typeof v === "number" ? v : v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number" ? (v as { value: number }).value : null;
const numbersOnly = (r: Record<string, unknown>): Record<string, number | null> =>
  Object.fromEntries(Object.entries(r).filter(([, v]) => v === null || typeof v === "number")) as Record<string, number | null>;
function adaptOption(o: z.infer<typeof BackendOption>): Option {
  return {
    candidateId: o.candidate_id,
    label: o.label ?? o.candidate_id,
    origin: o.origin ?? "generated",
    plans: o.plans as BackendPlanShape[],
    legStatus: o.leg_status.map(asStatus),
    indicators: Object.fromEntries(
      Object.entries(o.indicators).map(([name, i]) => [
        name,
        {
          name,
          value: nn(i.value),
          unit: nn(i.unit),
          direction: i.direction === "lower_better" || i.direction === "higher_better" ? i.direction : null,
          origin: asOrigin(i.origin, "calculation"),
          status: asStatus(i.status),
          definition: nn(i.definition),
          rationale: nn(i.rationale),
          source: source(i.source),
          perLeg: i.per_leg.map(perLegValue),
          inPriorities: i.in_priorities ?? false,
        },
      ]),
    ),
    rankPositions: numbersOnly(o.rank_positions),
    wins: o.wins,
    loses: o.loses,
    why: o.why.map((w) => ({ indicator: w.indicator, text: w.text, source: source(w.source) })),
    tradeOffs: o.trade_offs.map((t) => ({
      versus: t.versus,
      text: t.text,
      worseOn: t.worse_on.map((w) => ({ indicator: w.indicator, value: nn(w.value), versusValue: nn(w.versus_value), inPriorities: w.in_priorities ?? false })),
    })),
    uncertainties: o.uncertainties.map((u) => ({ text: u.text, origin: asOrigin(u.origin, "assumed") })),
    vulnerabilities: o.historical_vulnerabilities.map((v) => ({
      year: String(v.year),
      indicator: v.indicator,
      planId: v.plan_id,
      value: nn(v.value),
      text: v.text,
      replay: v.replay ? { method: v.replay.method, path: v.replay.path, body: v.replay.body } : null,
    })),
    dominatedBy: o.dominated_by,
    missing: o.missing,
  };
}
export function adaptRecommendation(r: z.infer<typeof BackendRecommendation>): Recommendation {
  return {
    status: asStatus(r.status),
    resultId: nn(r.result_id),
    hemisphere: nn(r.hemisphere),
    method: r.method ? { indicatorsUsed: r.method.indicators_used, weights: numbersOnly(r.method.weights) as Record<string, number>, orderingText: nn(r.method.ordering_text), note: nn(r.method.note) } : null,
    shortlist: r.shortlist.map(adaptOption),
    notComparable: r.not_comparable.map(adaptOption),
    dominated: r.dominated.map(adaptOption),
    log: adaptLog(r.generation_log),
    gaps: r.gaps,
    reasonText: nn(r.reason_text),
  };
}

const BackendFutureSeason = z
  .object({
    season: z.union([z.string(), z.number()]),
    status: LooseStatus,
    plan: PlanShape.nullable().optional(),
    windows: z.array(z.object({ kind: z.string(), start: z.string(), end: z.string(), label: z.string().default(""), origin: str, source: BackendSource.nullable().optional(), field: str }).passthrough()).default([]),
    milestones: z
      .array(z.object({ date: z.string(), end_date: str, label: z.string().default(""), kind: z.string().default(""), flagged: z.boolean().default(false), origin: str, rule_ids: z.array(z.string()).default([]) }).passthrough())
      .default([]),
    decision_deadlines: z
      .array(z.object({ date: z.string(), decision: z.string(), switch_condition: str, next_check_date: str, rule_ids: z.array(z.string()).default([]) }).passthrough())
      .default([]),
    explanations: z.array(z.object({ rule_id: z.string(), text: z.string().default(""), status: LooseStatus, origin: str, source: BackendSource.nullable().optional() }).passthrough()).default([]),
    warnings: z.array(z.union([z.string(), z.object({ text: z.string() }).passthrough()])).default([]),
    backup: z.object({ status: LooseStatus, fallback_plan_id: str, divergence: z.object({ what: str }).passthrough().nullable().optional() }).passthrough().nullable().optional(),
    notes: z.array(z.union([z.string(), z.object({ text: z.string() }).passthrough()])).default([]),
  })
  .passthrough();
export const BackendFuture = z
  .object({
    meta: GlobalMeta.optional(),
    status: LooseStatus,
    start_season: z.union([z.string(), z.number()]).nullable().optional(),
    seasons: z.array(BackendFutureSeason).default([]),
    note: str,
    dates_basis: str,
    diff: z.object({ changes: z.array(z.object({ field: z.string().default(""), from: z.unknown(), to: z.unknown(), text: str }).passthrough()).default([]) }).passthrough().nullable().optional(),
  })
  .passthrough();
const textOf = (x: string | { text: string }) => (typeof x === "string" ? x : x.text);
export function adaptFuture(r: z.infer<typeof BackendFuture>): FuturePlan {
  return {
    status: asStatus(r.status),
    startSeason: r.start_season == null ? null : String(r.start_season),
    note: nn(r.note),
    datesBasis: nn(r.dates_basis),
    diff: (r.diff?.changes ?? []).map((c) => ({ field: c.field, from: c.from, to: c.to, text: nn(c.text) })),
    seasons: r.seasons.map((s) => ({
      season: String(s.season),
      status: asStatus(s.status),
      plan: (s.plan as BackendPlanShape | null | undefined) ?? null,
      windows: s.windows.map((w) => ({ kind: w.kind, start: w.start, end: w.end, label: w.label, origin: asOrigin(w.origin, "assumed"), source: source(w.source), field: nn(w.field) })),
      milestones: s.milestones.map((m) => ({ date: m.date, endDate: nn(m.end_date), label: m.label, kind: m.kind, flagged: m.flagged, origin: asOrigin(m.origin, "assumed"), ruleIds: m.rule_ids })),
      deadlines: s.decision_deadlines.map((d) => ({ date: d.date, decision: d.decision, switchCondition: nn(d.switch_condition), nextCheckDate: nn(d.next_check_date), ruleIds: d.rule_ids })),
      explanations: s.explanations.map((e) => ({ ruleId: e.rule_id, text: e.text, status: asStatus(e.status), origin: asOrigin(e.origin), source: source(e.source) })),
      warnings: s.warnings.map(textOf),
      backup: s.backup ? { status: asStatus(s.backup.status), fallbackPlanId: nn(s.backup.fallback_plan_id), what: nn(s.backup.divergence?.what) } : null,
      notes: s.notes.map(textOf),
    })),
  };
}

/** Request pieces shared by generate / recommend / future. */
export function toBackendPlace(p: PlanPlace) {
  if ("point" in p) return { location: { latitude: p.point.latitude, longitude: p.point.longitude } };
  if ("cellId" in p) return { location: { cell_id: p.cellId } };
  return { location_id: p.locationId };
}
export function toBackendGoals(g: Goals) {
  const c = g.constraints ?? {};
  const p = g.preferences ?? {};
  return {
    priorities: Object.fromEntries(Object.entries(g.priorities).filter(([, v]) => typeof v === "number")),
    constraints: {
      allowed_crops: c.allowedCrops ?? null,
      excluded_crops: c.excludedCrops ?? [],
      must_include: c.mustInclude ?? [],
      irrigation: c.irrigation ?? "unknown",
      equipment: c.equipment ?? [],
      latest_planting: c.latestPlanting ?? null,
      earliest_harvest: c.earliestHarvest ?? null,
      ...(c.seasons != null ? { seasons: c.seasons } : {}),
    },
    preferences: { liked_crops: p.likedCrops ?? [], disliked_crops: p.dislikedCrops ?? [] },
  };
}
export const toBackendPlanningField = (f: PlanningField) => ({ field_id: f.fieldId, area_ha: f.areaHa, crop_history: f.cropHistory, ...(f.equipment ? { equipment: f.equipment } : {}), soil: null });

// ================================================================== Scenario Simulator (§11–§16)
// Shapes from docs/global/contract.md §11–§16. Values are renamed and regrouped only; every
// median, band, badge, delta and odds figure is the backend's own.

const BackendDist = z
  .object({ p10: num, median: num, p90: num, unit: str, currency: str, origin: str, includes_assumption: str, probability: num })
  .passthrough();
const dist = (d: z.infer<typeof BackendDist> | null | undefined): Dist | null =>
  d
    ? {
        p10: nn(d.p10),
        median: nn(d.median),
        p90: nn(d.p90),
        unit: nn(d.unit),
        currency: nn(d.currency),
        // A folded-in loss assumption makes the value the farmer's estimate, never a measurement.
        origin: d.includes_assumption ? "assumed" : asOrigin(d.origin, "calculation"),
        includesAssumption: nn(d.includes_assumption),
      }
    : null;
const distOrOdds = (d: z.infer<typeof BackendDist>): Dist | Odds =>
  d.probability !== undefined && d.median === undefined ? { probability: nn(d.probability), origin: asOrigin(d.origin, "calculation") } : (dist(d) as Dist);

/** A season plan from the backend, kept in the backend's own plan shape (farm/types.ts FieldPlan). */
const BackendRotationPlan = z
  .object({
    plan_id: z.string(),
    label: str,
    previous_crop_id: z.string(),
    next_crop_id: z.string(),
    prev_harvest: z.string(),
    next_plant: z.string(),
    winter: z.object({ kind: z.enum(["none", "cover", "winter_grain"]) }).passthrough(),
  })
  .passthrough();
export function asFieldPlan(raw: unknown): FieldPlan | null {
  const p = BackendRotationPlan.safeParse(raw);
  if (!p.success) return null;
  const w = p.data.winter as Record<string, string>;
  const winter: FieldPlan["winter"] =
    w.kind === "cover"
      ? { kind: "cover", crop_id: w.crop_id ?? "", seed: w.seed ?? "", terminate: w.terminate ?? "" }
      : w.kind === "winter_grain"
        ? { kind: "winter_grain", crop_id: w.crop_id ?? "", plant: w.plant ?? "", harvest: w.harvest ?? "" }
        : { kind: "none" };
  const origins = (p.data as { origins?: unknown }).origins;
  return {
    plan_id: p.data.plan_id,
    ...(p.data.label ? { label: p.data.label } : {}),
    previous_crop_id: p.data.previous_crop_id,
    next_crop_id: p.data.next_crop_id,
    prev_harvest: p.data.prev_harvest,
    next_plant: p.data.next_plant,
    winter,
    ...(origins && typeof origins === "object" && !Array.isArray(origins) ? { origins: origins as FieldPlan["origins"] } : {}),
  };
}
const fieldPlanToBackend = (p: FieldPlan) => ({
  plan_id: p.plan_id,
  ...(p.label ? { label: p.label } : {}),
  previous_crop_id: p.previous_crop_id,
  next_crop_id: p.next_crop_id,
  prev_harvest: p.prev_harvest,
  next_plant: p.next_plant,
  winter: p.winter,
  grower: { low_moisture_concern: p.grower?.low_moisture_concern ?? null },
});

/** How each season is farmed beyond "one crop, then the next" (card 21), keyed by plan id; empty when every season is an ordinary yearly one. */
export function systemsOf(rotation: FieldPlan[]): Record<string, { companions?: string[]; ground?: "permanent"; sold?: boolean }> {
  const out: Record<string, { companions?: string[]; ground?: "permanent"; sold?: boolean }> = {};
  for (const p of rotation) {
    if (p.permanent) out[p.plan_id] = { ground: "permanent", sold: p.permanent.sold };
    else if (p.companions?.length) out[p.plan_id] = { companions: p.companions.filter((c) => c && c !== p.next_crop_id).slice(0, 3) };
  }
  return out;
}

const BackendScenarioResult = z
  .object({
    scenario_id: z.string(),
    label: str,
    status: LooseStatus,
    reason_text: str,
    timeline: z.array(z.object({ year: int, season: z.union([z.string(), z.number()]).nullable().optional(), crop_sequence: z.array(z.string()).default([]), plan_id: str, companions: z.array(z.string()).optional(), ground: z.string().optional() }).passthrough()).default([]),
    system_notes: z.array(z.object({ kind: z.string(), text: z.string() }).passthrough()).optional(),
    yearly: z
      .array(
        z
          .object({
            year: int,
            indicators: z.record(BackendDist).default({}),
            money: z.object({ revenue: BackendDist.nullable().optional(), costs: BackendDist.nullable().optional(), margin: BackendDist.nullable().optional() }).passthrough().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    totals: z.record(z.union([BackendDist, z.number(), z.string(), z.array(z.unknown()), z.null()])).default({}),
    events: z.array(z.object({ event: z.string(), probability: num, text: z.string() }).passthrough()).default([]),
    money_status: LooseStatus,
    money_gaps: z.array(z.union([z.string(), z.object({ text: z.string() }).passthrough()])).default([]),
    readings_context: z
      .array(z.object({ date: z.string(), kind: z.string(), value: num, origin: str, modeled_same_day: z.record(z.unknown()).nullable().optional() }).passthrough())
      .default([]),
  })
  .passthrough();

export const BackendSimulation = z
  .object({
    meta: GlobalMeta.optional(),
    status: LooseStatus,
    reason_text: str,
    method: z.object({ weather: str, runs: num, seed: num, source_years: str, note: str }).passthrough().nullable().optional(),
    scenarios: z.array(BackendScenarioResult).default([]),
    comparison: z
      .object({
        baseline: str,
        badges: z.array(z.object({ badge: z.string(), scenario_id: z.string(), why: z.string().default("") }).passthrough()).default([]),
        deltas: z
          .array(
            z
              .object({
                scenario_id: z.string(),
                versus: z.string(),
                changes: z.array(z.object({ indicator: z.string(), median_delta: num, delta: num, currency: str, unit: str, text: z.string().default("") }).passthrough()).default([]),
              })
              .passthrough(),
          )
          .default([]),
        trade_offs: z.array(z.object({ scenario_id: z.string(), text: z.string() }).passthrough()).default([]),
        not_decided: z.array(z.union([z.string(), z.object({ badge: str, reason_text: str, text: str }).passthrough()])).default([]),
        caveat: str,
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const OUTLOOK_NOTE = "An evidence-based outlook from this field's real past seasons. It shows what to plan for under conditions seen here; it cannot say what any single year will bring.";
const CAVEAT = "The stronger of the plans you compared, given these numbers and the conditions seen at this field. An evidence-based outlook, not a guarantee.";

export function adaptSimulation(r: z.infer<typeof BackendSimulation>): Simulation {
  const c = r.comparison;
  return {
    status: asStatus(r.status),
    reasonText: nn(r.reason_text),
    method: {
      weather: r.method?.weather ?? "historical_resampling",
      runs: nn(r.method?.runs),
      seed: nn(r.method?.seed),
      sourceYears: nn(r.method?.source_years),
      // The label is always there, whether or not the backend repeated it.
      note: r.method?.note || OUTLOOK_NOTE,
    },
    scenarios: r.scenarios.map((s) => ({
      scenarioId: s.scenario_id,
      label: s.label ?? s.scenario_id,
      status: asStatus(s.status),
      reasonText: nn(s.reason_text),
      timeline: s.timeline.map((t) => ({ year: t.year, season: String(t.season ?? t.year), cropSequence: t.crop_sequence, planId: nn(t.plan_id), ...(t.companions?.length ? { companions: t.companions } : {}), ...(t.ground ? { ground: t.ground } : {}) })),
      ...(s.system_notes?.length ? { systemNotes: s.system_notes.map((n) => ({ kind: n.kind, text: n.text })) } : {}),
      yearly: s.yearly.map((y) => ({
        year: y.year,
        indicators: Object.fromEntries(Object.entries(y.indicators).map(([k, v]) => [k, distOrOdds(v)])),
        money: y.money ? { revenue: dist(y.money.revenue), costs: dist(y.money.costs), margin: dist(y.money.margin) } : null,
      })),
      totals: Object.fromEntries(Object.entries(s.totals).flatMap(([k, v]): Array<[string, Dist | number | null]> => {
        if (typeof v === "number" || v === null) return [[k, v]];
        if (typeof v !== "object" || Array.isArray(v) || !["median", "p10", "p90", "value"].some(key => key in v)) return [];
        return [[k, dist(BackendDist.parse(v))]];
      })),
      events: s.events.map((e) => ({ event: e.event, probability: nn(e.probability), text: e.text })),
      moneyStatus: asStatus(s.money_status),
      moneyGaps: s.money_gaps.map((g) => (typeof g === "string" ? g : g.text)),
      nothingSold: s.money_gaps.some((g) => typeof g !== "string" && (g as { reason?: unknown }).reason === "nothing_sold"),
      readingsContext: s.readings_context.map((x) => ({
        date: x.date,
        kind: x.kind,
        value: nn(x.value),
        origin: asOrigin(x.origin, "grower"),
        modeled: Object.entries(x.modeled_same_day ?? {})
          .filter(([k]) => k !== "origin")
          .map(([name, value]) => ({ name, value: typeof value === "number" ? value : null, origin: asOrigin(String(x.modeled_same_day?.origin ?? ""), "nasa_modeled") })),
      })),
    })),
    comparison: c
      ? {
          baseline: nn(c.baseline),
          badges: c.badges.map((b) => ({ badge: b.badge, scenarioId: b.scenario_id, why: b.why })),
          deltas: c.deltas.map((d) => ({
            scenarioId: d.scenario_id,
            versus: d.versus,
            changes: d.changes.map((x) => ({ indicator: x.indicator, medianDelta: nn(x.median_delta ?? x.delta), currency: nn(x.currency), unit: nn(x.unit), text: x.text })),
          })),
          tradeOffs: c.trade_offs.map((t) => ({ scenarioId: t.scenario_id, text: t.text })),
          notDecided: c.not_decided.map((n) => (typeof n === "string" ? { badge: n, reasonText: "" } : { badge: n.badge ?? "", reasonText: n.reason_text ?? n.text ?? "" })),
          caveat: c.caveat || CAVEAT,
        }
      : null,
    raw: r as Record<string, unknown>,
  };
}

export interface SimulateRequest {
  point: LatLonPoint;
  regionKey?: string | null;
  field: { fieldId: string; name: string; areaHa: number | null; geometry?: Farm["fields"][number]["geometry"] | null; equipment: string[]; readings: Reading[]; zones?: Array<{ zoneId: string; name: string; share: number }> };
  priorities: Record<string, number>;
  overrides: Record<string, CropOverride>;
  loss: LossAssumptions;
  scenarios: Scenario[];
  years?: number;
  runs?: number;
  seed?: number;
  /** "trend" adjusts rain for the trend seen in the field's own record when it is statistically clear; "none" uses the record as recorded. Defaults to "trend". */
  climate?: "none" | "trend";
  startSeason: string;
}
type LatLonPoint = { latitude: number; longitude: number };
export const toBackendReading = (r: Reading) => ({ date: r.date, kind: r.kind, value: r.value, ...(r.depthCm != null ? { depth_cm: r.depthCm } : {}), ...(r.note ? { note: r.note } : {}), ...(r.name ? { name: r.name } : {}), ...(r.unit ? { unit: r.unit } : {}), ...(r.moisture_basis ? { moisture_basis: r.moisture_basis } : {}) });
const toBackendOverrides = (o: Record<string, CropOverride>) =>
  Object.fromEntries(
    Object.entries(o).map(([crop, v]) => [
      crop,
      {
        ...(v.priceCases && Object.keys(v.priceCases).length ? { price: { ...Object.fromEntries(Object.entries(v.priceCases).map(([k, q]) => [k, q.value])), unit: (v.priceCases.typical ?? Object.values(v.priceCases)[0])!.unit } } : v.price ? { price: v.price } : {}),
        ...(v.yield ? { yield: v.yield } : {}),
        ...(v.costItems?.length ? { costs: v.costItems.map(({ item, value, unit }) => ({ item, value, unit })) } : v.costPerArea ? { costs: { total: v.costPerArea } } : {}),
      },
    ]),
  );
const allLegs = (s: { rotation: FieldPlan[]; zoneRotations?: Record<string, FieldPlan[]> }) => [...s.rotation, ...Object.values(s.zoneRotations ?? {}).flat()];
export function toBackendSimulate(q: SimulateRequest) {
  return {
    location: { latitude: q.point.latitude, longitude: q.point.longitude },
    field: { field_id: q.field.fieldId, name: q.field.name, area_ha: q.field.areaHa, geometry: q.field.geometry ?? null, equipment: q.field.equipment, readings: q.field.readings.map(toBackendReading), ...(q.regionKey ? { region_key: q.regionKey } : {}), ...(q.field.zones?.length ? { zones: q.field.zones.map((z) => ({ zone_id: z.zoneId, name: z.name, share: z.share })) } : {}) },
    goals: { priorities: q.priorities },
    economics: {
      overrides: toBackendOverrides(q.overrides),
      loss_assumptions: { dry_spring_pct: q.loss.drySpringPct, heavy_rain_pct: q.loss.heavyRainPct },
    },
    scenarios: q.scenarios.map((s) => ({ scenario_id: s.scenarioId, label: s.label, ...(s.isBaseline ? { is_baseline: true } : {}), ...(Object.keys(systemsOf(allLegs(s))).length ? { systems: systemsOf(allLegs(s)) } : {}), // A zoned baseline sends each zone's own rotation; every other scenario sends one rotation for the whole field.
      rotation: s.zoneRotations && q.field.zones?.length ? undefined : s.rotation.map(fieldPlanToBackend),
      zone_rotations: s.zoneRotations && q.field.zones?.length ? Object.fromEntries(Object.entries(s.zoneRotations).map(([id, r]) => [id, r.map(fieldPlanToBackend)])) : undefined })),
    years: q.years ?? 10,
    runs: q.runs ?? 200,
    seed: q.seed ?? 7,
    climate: q.climate ?? "trend",
    start_season: q.startSeason,
  };
}

// §12 economics
const BackendMoneySource = BackendSource.and(z.object({ years: z.union([z.string(), z.number()]).nullable().optional(), year: z.union([z.string(), z.number()]).nullable().optional() }).passthrough());
const moneySource = (s: z.infer<typeof BackendMoneySource> | null | undefined): MoneyRef["source"] => {
  if (!s || (!s.title && !s.url)) return null;
  const base = source(s)!;
  const yrs = s.years ?? s.year;
  return { ...base, years: yrs == null ? null : String(yrs) };
};
const BackendMoney = z.object({ value: num, unit: str, origin: str, source: BackendMoneySource.nullable().optional() }).passthrough();
const money = (m: z.infer<typeof BackendMoney> | null | undefined): MoneyRef | null =>
  m ? { value: nn(m.value), unit: nn(m.unit), origin: asOrigin(m.origin), source: moneySource(m.source) } : null;
export const BackendEconomics = z
  .object({
    meta: GlobalMeta.optional(),
    currency: z.string().default("USD"),
    area_unit: z.enum(["acre", "ha"]).default("acre"),
    crops: z
      .array(
        z
          .object({
            crop_id: z.string(),
            status: LooseStatus,
            reason_text: str,
            price: z.object({ low: num, typical: num, high: num, unit: str, origin: str, source: BackendMoneySource.nullable().optional() }).passthrough().nullable().optional(),
            yield: BackendMoney.nullable().optional(),
            costs: z
              .object({ items: z.array(BackendMoney.and(z.object({ item: z.string() }).passthrough())).default([]), total_per_area: z.object({ value: num, unit: str }).passthrough().nullable().optional() })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
    equipment_costs: z.array(BackendMoney.and(z.object({ equipment: z.string(), pass: str }).passthrough())).default([]),
    gaps: z.array(z.union([z.string(), z.object({ text: z.string() }).passthrough()])).default([]),
  })
  .passthrough();
export function adaptEconomics(r: z.infer<typeof BackendEconomics>): Economics {
  return {
    currency: r.currency,
    areaUnit: r.area_unit,
    crops: r.crops.map((c) => ({
      cropId: c.crop_id,
      status: asStatus(c.status),
      reasonText: nn(c.reason_text),
      price: c.price ? { low: nn(c.price.low), typical: nn(c.price.typical), high: nn(c.price.high), unit: nn(c.price.unit), origin: asOrigin(c.price.origin), source: moneySource(c.price.source) } : null,
      yield: money(c.yield),
      costs: c.costs
        ? {
            items: c.costs.items.map((i) => ({ item: i.item, ...money(i)! })),
            totalPerArea: c.costs.total_per_area ? { value: nn(c.costs.total_per_area.value), unit: nn(c.costs.total_per_area.unit) } : null,
          }
        : null,
    })),
    equipmentCosts: r.equipment_costs.map((e) => ({ equipment: e.equipment, pass: nn(e.pass), ...money(e)! })),
    gaps: r.gaps.map((g) => (typeof g === "string" ? g : g.text)),
  };
}
export const toBackendEconomics = (q: { point: LatLonPoint; crops: string[]; area: { value: number | null; unit: "acre" | "ha" }; equipment: string[]; overrides: Record<string, CropOverride> }) => ({
  location: { latitude: q.point.latitude, longitude: q.point.longitude },
  crops: q.crops,
  ...(q.area.value != null && q.area.value > 0 ? { area: q.area } : {}),
  equipment: q.equipment,
  overrides: toBackendOverrides(q.overrides),
});

// §13 crop library
export const BackendCropSearch = z
  .object({
    meta: GlobalMeta.optional(),
    results: z
      .array(
        z
          .object({ crop_id: z.string(), name: z.string(), family: str, roles: z.array(z.string()).default([]), origin: str, has_calendar: z.boolean().default(false), has_economics: z.boolean().default(false), region_note: str })
          .passthrough(),
      )
      .default([]),
    can_research: z.boolean().default(false),
  })
  .passthrough();
export const adaptCropSearch = (r: z.infer<typeof BackendCropSearch>): CropSearch => ({
  results: r.results.map((c) => ({
    cropId: c.crop_id,
    name: c.name,
    family: nn(c.family),
    roles: c.roles,
    origin: asOrigin(c.origin),
    hasCalendar: c.has_calendar,
    hasEconomics: c.has_economics,
    regionNote: nn(c.region_note),
  })),
  canResearch: r.can_research,
});
export const BackendCropJob = z
  .object({ meta: GlobalMeta.optional(), job_id: str, job_status: str, crop_id: str, reason_text: str, crop: z.object({ crop_id: z.string() }).passthrough().nullable().optional() })
  .passthrough();
export const adaptCropJob = (r: z.infer<typeof BackendCropJob>): CropJob => ({
  jobId: nn(r.job_id),
  jobStatus: asJob(r.job_status, "pending"),
  cropId: r.crop_id ?? r.crop?.crop_id ?? null,
  reasonText: nn(r.reason_text),
});

// §14 and §16 vocabularies (each item may be a bare id or {id|name|value, label, explanation})
export const BackendVocab = z
  .object({
    meta: GlobalMeta.optional(),
    items: z.array(z.unknown()).optional(),
    equipment: z.array(z.unknown()).optional(),
    readings: z.array(z.unknown()).optional(),
    kinds: z.array(z.unknown()).optional(),
    priorities: z.array(z.unknown()).optional(),
  })
  .passthrough();
export function adaptVocab(r: z.infer<typeof BackendVocab>): VocabItem[] {
  const list = r.items ?? r.equipment ?? r.readings ?? r.kinds ?? r.priorities ?? [];
  return list.flatMap((x): VocabItem[] => {
    if (typeof x === "string") return [{ id: x, label: cropName(x), explanation: null }];
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    const id = (o.id ?? o.priority_id ?? o.name ?? o.value ?? o.key) as string | undefined;
    if (typeof id !== "string") return [];
    const expl = o.explanation ?? o.description ?? o.help;
    return [{ id, label: typeof o.label === "string" ? o.label : cropName(id), explanation: typeof expl === "string" ? expl : null }];
  });
}

// §15 demo and autofill
const BackendDemoField = z
  .object({
    field_id: z.string(),
    name: z.string(),
    geometry: z.object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: z.array(z.unknown()) }).passthrough(),
    plan: z.unknown().optional(),
    rotation: z.array(z.unknown()).optional(),
    equipment: z.array(z.string()).default([]),
    readings: z.array(z.object({ date: z.string(), kind: z.string(), value: num, depth_cm: num, note: str }).passthrough()).default([]),
  })
  .passthrough();
export const BackendDemo = z
  .object({
    meta: GlobalMeta.optional(),
    label: z.string().default("Demo farm (example values)"),
    farm: z.object({ farm_id: z.string(), name: z.string(), anchor: BackendPoint.nullable().optional(), fields: z.array(BackendDemoField).min(1) }).passthrough(),
    current_plans: z.union([z.record(z.unknown()), z.array(z.unknown())]).nullable().optional(),
    economics_overrides: z.record(z.unknown()).nullable().optional(),
    goals: z.object({ priorities: z.record(z.number()).default({}) }).passthrough().nullable().optional(),
    loss_assumptions: z.object({ dry_spring_pct: num, wet_spring_pct: num, heavy_rain_pct: num }).passthrough().nullable().optional(),
  })
  .passthrough();
const asKind = (k: string): ReadingKind => ((READING_KINDS as readonly string[]).includes(k) ? (k as ReadingKind) : "note");
const toPlans = (v: unknown): FieldPlan[] => (Array.isArray(v) ? v : v ? [v] : []).map(asFieldPlan).filter((p): p is FieldPlan => Boolean(p));
const pickOverride = (v: unknown): CropOverride => {
  const o = (v ?? {}) as Record<string, unknown>;
  const vu = (x: unknown) => {
    if (!x || typeof x !== "object") return null;
    const q = x as { value?: unknown; unit?: unknown };
    return typeof q.value === "number" && Number.isFinite(q.value) ? { value: q.value, unit: String(q.unit ?? "") } : null;
  };
  const costs = o.costs as Record<string, unknown> | undefined;
  return { price: vu(o.price), yield: vu(o.yield), costPerArea: vu(costs?.total ?? costs?.total_per_area ?? costs ?? o.cost_per_area) };
};
export function adaptDemo(r: z.infer<typeof BackendDemo>, now = new Date().toISOString()): DemoFarm {
  // current_plans: {field_id: Plan | Plan[]} or [{field_id, rotation|plans|plan}]
  const plansFor = (fieldId: string): FieldPlan[] => {
    const cp = r.current_plans;
    if (Array.isArray(cp)) {
      const row = cp.find((x) => (x as { field_id?: string }).field_id === fieldId) as Record<string, unknown> | undefined;
      return row ? toPlans(row.rotation ?? row.plans ?? row.plan) : [];
    }
    return cp ? toPlans(cp[fieldId]) : [];
  };
  const fields: DemoFarm["fields"] = {};
  const farmFields = r.farm.fields.map((f) => {
    const rotation = plansFor(f.field_id).length ? plansFor(f.field_id) : toPlans(f.rotation ?? f.plan);
    fields[f.field_id] = {
      rotation,
      equipment: f.equipment,
      readings: f.readings.map((x) => ({ date: x.date, kind: asKind(x.kind), value: nn(x.value), depthCm: nn(x.depth_cm), note: nn(x.note) })),
    };
    return {
      field_id: f.field_id, name: f.name, geometry: f.geometry as unknown as Farm["fields"][number]["geometry"], plan: rotation[0] ?? null,
      equipment: f.equipment,
      readings: f.readings.map(x => ({ date: x.date, kind: asKind(x.kind), value: nn(x.value), depth_cm: nn(x.depth_cm), note: nn(x.note) })),
    };
  });
  const first = r.farm.fields[0]!.geometry as unknown as { type: string; coordinates: number[][][] | number[][][][] };
  const ring = (first.type === "Polygon" ? (first.coordinates as number[][][])[0] : (first.coordinates as number[][][][])[0]?.[0]) ?? [];
  // The map centre only (where to open the map); the backend works from the field geometry.
  const anchor = r.farm.anchor ?? { latitude: ring[0]?.[1] ?? 0, longitude: ring[0]?.[0] ?? 0 };
  return {
    label: r.label,
    farm: { schema: "acre.farm.v1", farm_id: r.farm.farm_id, name: r.farm.name, anchor: { latitude: anchor.latitude, longitude: anchor.longitude }, fields: farmFields, created_at: now, updated_at: now },
    fields,
    overrides: Object.fromEntries(Object.entries(r.economics_overrides ?? {}).map(([k, v]) => [k, pickOverride(v)])),
    priorities: r.goals?.priorities ?? {},
    lossAssumptions: { drySpringPct: nn(r.loss_assumptions?.dry_spring_pct), wetSpringPct: nn(r.loss_assumptions?.wet_spring_pct), heavyRainPct: nn(r.loss_assumptions?.heavy_rain_pct) },
  };
}

export const BackendAutofill = z
  .object({
    meta: GlobalMeta.optional(),
    plan: z.unknown().optional(),
    dates: z.array(z.object({ field: z.string(), value: str, origin: str, source: BackendSource.nullable().optional() }).passthrough()).default([]),
    gaps: z.array(z.union([z.string(), z.object({ text: z.string() }).passthrough()])).default([]),
  })
  .passthrough();
export const adaptAutofill = (r: z.infer<typeof BackendAutofill>): Autofill => ({
  plan: asFieldPlan(r.plan),
  dates: r.dates.map((d) => ({ field: d.field, value: nn(d.value), origin: asOrigin(d.origin), source: source(d.source) })),
  gaps: r.gaps.map((g) => (typeof g === "string" ? g : g.text)),
});
export const toBackendAutofill = (point: LatLonPoint, crops: Array<{ role: "previous" | "cover" | "next"; cropId: string }>) => ({
  location: { latitude: point.latitude, longitude: point.longitude },
  crops: crops.map((c) => ({ role: c.role, crop_id: c.cropId })),
});
