import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
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

function webgl(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function StrategySim({ title, rotation, geometry, monthly, conditions, at, startSeason }: { title: string; rotation: FieldPlan[]; geometry: FieldGeometry; monthly: ScenarioMonthly | null; conditions: FieldConditions | null; at: string; startSeason: number }) {
  const south = centroid(geometry).latitude < 0;
  const plans = useMemo(() => rotation.map((p) => scenePlan(p, south)), [rotation, south]);
  const palette = useMemo(readPalette, []);
  const can3d = useMemo(webgl, []);
  const [mounted, setMounted] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [view, setView] = useState<"field" | "cutaway">("field");
  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 80);
    return () => window.clearTimeout(id);
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
  const spent = before ? 0 : cur?.cumulative_costs?.median;
  const earned = before ? 0 : cur?.cumulative_revenue?.median;
  const net = before ? 0 : cur?.cumulative_net?.median;
  const ops = now?.operations ?? [];
  const spentNow = now?.costs?.median ?? 0;
  const earnedNow = now?.revenue?.median ?? 0;
  const wet = top?.median ?? null;

  return (
    <div className="ss" aria-label={`${title}: simulation at ${monthTitle(at)}`}>
      <dl className="ss-hud">
        <div>
          <dt>Spent so far</dt>
          <dd>{fmt(spent)}</dd>
        </div>
        <div>
          <dt>Earned so far</dt>
          <dd>{fmt(earned)}</dd>
        </div>
        <div className={net != null && net < 0 ? "ss-neg" : "ss-pos"}>
          <dt>Net so far</dt>
          <dd>{fmt(net)}</dd>
          {!before && cur?.cumulative_net?.p10 != null && cur.cumulative_net.p90 != null && cur.cumulative_net.p10 !== cur.cumulative_net.p90 ? (
            <dd className="ss-range">
              bad year {fmt(cur.cumulative_net.p10)} · good year {fmt(cur.cumulative_net.p90)}
            </dd>
          ) : null}
        </div>
      </dl>
      {monthly == null ? <p className="gf-muted sb-small">No money result for this plan, so only the field is shown.</p> : null}
      <div className="ss-stage">
        {can3d && mounted ? (
          <Boundary fallback={<p className="ss-fallback">The 3D field could not start on this device.</p>}>
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
      <ul className="ss-now">
        <li>
          <strong>On the field:</strong> {state?.label ?? "No complete plan for this season"}
          {leg?.sequence ? ` (${cropLabel(rotation[t % rotation.length]!.next_crop_id)} season)` : ""}
        </li>
        <li>
          <strong>This month:</strong>{" "}
          {ops.length ? ops.map((o) => `${OP_TEXT[o.kind] ?? o.kind} ${o.crop_id ? cropLabel(o.crop_id).toLowerCase() : ""}`.trim()).join("; ") : "No field work planned"}
          {spentNow > 0 ? ` · spend ${fmt(spentNow)}` : ""}
          {earnedNow > 0 ? ` · sell ${fmt(earnedNow)}` : ""}
          {now?.risks.length ? ` · Watch: ${now.risks.map((r) => r.text ?? r.kind).join("; ")}` : ""}
        </li>
        {cond ? (
          <li className="ss-cond">
            <strong>Soil in a typical {monthShort(month)}:</strong>{" "}
            {wet != null ? (
              <>
                <span className="ss-wet" role="img" aria-label={`Topsoil wetness ${pctOf(wet)}`}>
                  <span style={{ width: `${Math.round(wet * 100)}%` }} />
                </span>{" "}
                {pctOf(wet)} wet (dry year {pctOf(top?.p10)}, wet year {pctOf(top?.p90)})
              </>
            ) : (
              "Not available"
            )}
            {cond.rain_mm?.median != null ? ` · rain ${Math.round(cond.rain_mm.median)} mm` : ""}
            {cond.air_temp_c?.median != null ? ` · ${Math.round(cond.air_temp_c.median)}°C` : ""}
            <span className="ss-src"> NASA model, ~50 km area{conditions?.years ? `, ${conditions.years}` : ""}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
