import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import type { CardKey } from "../../content/strategies";
import { centroid } from "../../farm/geometry";
import type { FieldGeometry, FieldPlan } from "../../farm/types";
import { rotationStateAt } from "../../scene/growth";
import type { MonthlyMonth, ScenarioMonthly } from "../../sim/schema";
import type { StripVM } from "../../view/build";
import { cropLabel, money } from "../guided/format";
import { readPalette } from "../planner/FarmView";
import { scenePlan } from "./FarmScene";

const FarmWorld = lazy(() => import("../../scene/FarmWorld"));

/*
  One strategy as a running simulation: the field in 3D on the chosen month, with the money
  spent, earned and left so far above it, what happens that month, and the field's typical
  condition for that time of year. The month comes from the shared timeline, so the strategies
  are always compared at the same date.

  Every number is the backend's: money from the scenario's `monthly` block, conditions from
  `field_conditions` (NASA POWER, modeled). The plants are an illustration of planned dates.
*/

const dist = z.object({ p10: z.number().nullable().optional(), median: z.number().nullable().optional(), p90: z.number().nullable().optional() }).passthrough();
const conditionsSchema = z
  .object({
    origin: z.string().optional(),
    years: z.string().optional(),
    text: z.string().optional(),
    months: z.array(z.object({ month: z.number(), soil_wetness_top: dist.nullable().optional(), soil_wetness_root: dist.nullable().optional(), rain_mm: dist.nullable().optional(), air_temp_c: dist.nullable().optional() }).passthrough()),
  })
  .passthrough();
export type FieldConditions = z.infer<typeof conditionsSchema>;
export function conditionsOf(raw: Record<string, unknown> | null): FieldConditions | null {
  const parsed = raw?.field_conditions == null ? null : conditionsSchema.safeParse(raw.field_conditions);
  return parsed?.success ? parsed.data : null;
}

const trendSchema = z.object({ slope_per_decade: z.number().nullable().optional(), unit: z.string().nullable().optional(), p_value: z.number().nullable().optional(), years: z.number().nullable().optional(), significant: z.boolean().nullable().optional(), pct_per_decade: z.number().nullable().optional() }).passthrough();
const climateSchema = z
  .object({
    mode: z.enum(["trend", "none"]).optional(),
    target_year: z.number().nullable().optional(),
    applied: z.boolean().optional(),
    reason: z.string().nullable().optional(),
    text: z.string().optional(),
    note: z.string().optional(),
    precip_trend: trendSchema.nullable().optional(),
    temperature_trend: trendSchema.nullable().optional(),
    factor_range: z.tuple([z.number(), z.number()]).nullable().optional(),
  })
  .passthrough();
export type ClimateAdjustment = z.infer<typeof climateSchema>;
/** The backend's `method.climate_adjustment` block; null when absent or not in the expected shape. */
export function climateAdjustmentOf(raw: Record<string, unknown> | null): ClimateAdjustment | null {
  const method = raw?.method;
  const block = method != null && typeof method === "object" && !Array.isArray(method) ? (method as Record<string, unknown>).climate_adjustment : null;
  const parsed = block == null ? null : climateSchema.safeParse(block);
  return parsed?.success ? parsed.data : null;
}

const OP_TEXT: Record<string, string> = { plant: "Plant", harvest: "Harvest", seed_cover: "Seed cover crop:", end_cover: "End cover crop:", plant_grain: "Plant winter grain:", harvest_grain: "Harvest winter grain:" };
const monthTitle = (ym: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-01T00:00:00Z`));
const monthShort = (m: number) => new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2001, m - 1, 1)));
const pctOf = (v: number | null | undefined) => (v == null ? null : `${Math.round(v * 100)}%`);

/** The latest month of this plan's calendar at or before `at`; null before its first month. */
export function monthAt(monthly: ScenarioMonthly | null, at: string): MonthlyMonth | null {
  let found: MonthlyMonth | null = null;
  for (const m of monthly?.months ?? []) {
    if (m.month > at) break;
    found = m;
  }
  return found;
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

let canWebgl: boolean | null = null;
/** Checked once per page, and the test context is released: every live WebGL context counts against the browser's limit. */
function webgl(): boolean {
  if (canWebgl != null) return canWebgl;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    canWebgl = Boolean(gl);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    canWebgl = false;
  }
  return canWebgl;
}

/** The field's usual weather for the timeline's month, shown once because it is the same for every plan. */
export function ConditionsLine({ conditions, at }: { conditions: FieldConditions | null; at: string }) {
  const month = Number(at.split("-")[1]);
  const cond = conditions?.months.find((m) => m.month === month) ?? null;
  if (!cond) return null;
  const wet = cond.soil_wetness_top?.median ?? null;
  const parts = [wet != null ? `topsoil ${pctOf(wet)} wet` : null, cond.rain_mm?.median != null ? `rain ${Math.round(cond.rain_mm.median)} mm` : null, cond.air_temp_c?.median != null ? `${Math.round(cond.air_temp_c.median)}°C` : null].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span className="gf-muted sb-small">
      Typical {monthShort(month)} here: {parts.join(" · ")} <span className="ss-src">(NASA model, ~50 km area{conditions?.years ? `, ${conditions.years}` : ""})</span>
    </span>
  );
}

export function StrategySim({ title, rotation, geometry, monthly, conditions, at, startSeason }: { title: string; rotation: FieldPlan[]; geometry: FieldGeometry; monthly: ScenarioMonthly | null; conditions: FieldConditions | null; at: string; startSeason: number }) {
  const south = centroid(geometry).latitude < 0;
  const plans = useMemo(() => rotation.map((p) => scenePlan(p, south)), [rotation, south]);
  const palette = useMemo(readPalette, []);
  const can3d = useMemo(webgl, []);
  const [mounted, setMounted] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [view, setView] = useState<"field" | "cutaway">("field");
  // A lost WebGL context (the browser reclaimed it) leaves a blank canvas: start the scene again, a few times at most.
  const [gen, setGen] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 80);
    return () => window.clearTimeout(id);
  }, []);
  // The scene draws on demand; ask for one more frame once it has had time to load, so it never starts blank.
  useEffect(() => {
    if (!mounted) return;
    const id = window.setTimeout(() => setResetKey((n) => n + 1), 900);
    return () => window.clearTimeout(id);
  }, [mounted, gen]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const lost = () => window.setTimeout(() => setGen((g) => (g < 3 ? g + 1 : g)), 300);
    // The mouse wheel scrolls the page, not the camera (pinch, or Ctrl + wheel, still zooms).
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey) e.stopPropagation(); };
    el.addEventListener("webglcontextlost", lost, true);
    el.addEventListener("wheel", wheel, true);
    return () => { el.removeEventListener("webglcontextlost", lost, true); el.removeEventListener("wheel", wheel, true); };
  }, []);

  const [year, month] = at.split("-").map(Number) as [number, number];
  // A southern field's seasons are six months on; the stage is drawn for a northern winter.
  const stageMonth = south ? ((month + 5) % 12) + 1 : month;
  const stageYear = south && month > 6 ? year + 1 : year;
  const state = rotationStateAt(plans, startSeason, stageYear, stageMonth);
  const cond = conditions?.months.find((m) => m.month === month) ?? null;
  const top = cond?.soil_wetness_top ?? null;
  const all = conditions?.months.flatMap((m) => [m.soil_wetness_top?.p10, m.soil_wetness_top?.p90]).filter((v): v is number => v != null) ?? [];
  const range: [number, number] | null = all.length ? [Math.min(...all), Math.max(...all)] : null;

  const t = Math.max(0, stageYear + (stageMonth >= 9 ? 1 : 0) - startSeason);
  const leg = plans.length ? plans[t % plans.length] : null;
  const strip: StripVM = {
    key: "sim" as CardKey,
    name: title,
    plan: leg ?? null,
    selected: false,
    status: null,
    weather: { year: null, complete: false, totalMm: null, medianMm: null, wetness: top?.median ?? null, wetnessRange: range },
  };

  const cur = monthAt(monthly, at);
  const now = monthly?.months.find((m) => m.month === at) ?? null;
  const c = monthly?.currency ?? null;
  const fmt = (v: number | null | undefined) => (v == null ? "Not available" : money(v, c));
  const before = monthly != null && cur == null;
  const net = before ? 0 : cur?.cumulative_net?.median;
  const ops = now?.operations ?? [];
  // A month with no entry in the plan's calendar has no spending or sales: a real 0, not a gap.
  const spentNow = monthly ? Math.abs(now?.costs?.median ?? 0) : null;
  const earnedNow = monthly ? (now?.revenue?.median ?? 0) : null;
  const netNow = monthly ? (now?.net?.median ?? (earnedNow ?? 0) - (spentNow ?? 0)) : null;
  const tone = (v: number | null | undefined) => (v == null || v === 0 ? undefined : v < 0 ? "ss-neg" : "ss-pos");

  return (
    <div className="ss" aria-label={`${title}: simulation at ${monthTitle(at)}`}>
      <div className="ss-stage" ref={stage}>
        {can3d && mounted ? (
          <Boundary key={gen} fallback={<p className="ss-fallback">The 3D field could not start on this device.</p>}>
            <Suspense fallback={<p className="ss-fallback" role="status">Loading the 3D field…</p>}>
              <FarmWorld strips={[strip]} states={[state]} outlines={[geometry]} day={0} preset={view} animate={false} palette={palette} onSelect={() => {}} resetKey={resetKey} />
            </Suspense>
          </Boundary>
        ) : (
          <p className="ss-fallback">{can3d ? "Loading the 3D field…" : "This device cannot show the 3D field."}</p>
        )}
        <p className="ss-date">{monthTitle(at)}</p>
        <div className="ss-tools">
          <button type="button" aria-pressed={view === "cutaway"} onClick={() => setView(view === "field" ? "cutaway" : "field")}>
            {view === "field" ? "Show soil" : "Show field"}
          </button>
          <button type="button" onClick={() => setResetKey((n) => n + 1)}>
            Reset view
          </button>
        </div>
      </div>
      <p className="ss-now">
        <strong>{state?.label ?? "No complete plan for this season"}</strong>
        {ops.length ? ` · ${ops.map((o) => `${OP_TEXT[o.kind] ?? o.kind} ${o.crop_id ? cropLabel(o.crop_id).toLowerCase() : ""}`.trim()).join("; ")}` : ""}
        {now?.risks.length ? ` · Watch: ${now.risks.map((r) => r.text ?? r.kind).join("; ")}` : ""}
      </p>
      {monthly ? (
        <dl className="ss-hud">
          <div>
            <dt>Spent this month</dt>
            <dd>{fmt(spentNow)}</dd>
          </div>
          <div>
            <dt>Sold this month</dt>
            <dd>{fmt(earnedNow)}</dd>
          </div>
          <div className={tone(netNow)}>
            <dt>Net this month</dt>
            <dd>{fmt(netNow)}</dd>
          </div>
          <div className={tone(net)}>
            <dt title="Sold minus spent, added up month by month since the start of the timeline">Running total</dt>
            <dd>{fmt(net)}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
