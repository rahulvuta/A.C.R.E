import { useEffect, useState } from "react";
import { asFieldPlan } from "../../api/adapt";
import { PRIORITY_NAMES, type Option, type Recommendation } from "../../api/model";
import type { Dist, Scenario, ScenarioResult, Simulation } from "../../api/simModel";
import { badgeLabels } from "../../sim/BadgeRow";
import { monthlySchema, type MonthlyMonth, type Origin, type ScenarioMonthly } from "../../sim/schema";
import { OriginLabel, readable } from "../../sim/shared";
import "../../sim/sim.css";
import { areaHa } from "../../farm/geometry";
import type { FieldPlan } from "../../farm/types";
import { MAX_ALTERNATIVES, updateSimField } from "../../state/simField";
import { useSimulation } from "../../state/useSimulation";
import { rotationReady, simulateRequest, type StepContext } from "../guided/context";
import { cropLabel, money, pct } from "../guided/format";
import { SimStatus } from "../guided/StepSimulate";

/*
  The Overview's decision view: up to three strategies side by side, each with what it spends
  and earns over 5 seasons of replayed past weather, month by month. One simulate request runs
  all of them. Every number is the backend's (`totals`, `monthly`, `comparison`); nothing is
  computed here. When the grower has added fewer than two plans, the plan finder's top
  suggestions (POST /v1/plans/recommend, as in Recommendations) fill the empty boxes.
*/
export const HORIZON_YEARS = 5;
const SLOTS = 3;

/** The backend's month-by-month block for one scenario; null when absent or not in the expected shape. */
export function monthlyOf(raw: Record<string, unknown>, scenarioId: string): ScenarioMonthly | null {
  const list = Array.isArray(raw.scenarios) ? (raw.scenarios as Array<Record<string, unknown>>) : [];
  const m = list.find((s) => s.scenario_id === scenarioId)?.monthly;
  const parsed = m == null ? null : monthlySchema.safeParse(m);
  return parsed?.success ? parsed.data : null;
}

/** The share of replayed seasons at which a risk month is shaded on the chart (display threshold only). */
export const RISK_SHADE_MIN = 0.1;

export interface BoxModel {
  slot: number;
  /** True when the plan finder suggested this plan; it is not in the grower's plans yet. */
  suggested?: boolean;
  /** Where the suggestion came from (the plan finder's own origin tag). */
  suggestedOrigin?: string | null;
  title: string;
  /** The grower's scenario in this slot; null when the slot is empty. */
  scenario: Scenario | null;
  result: ScenarioResult | null;
  monthly: ScenarioMonthly | null;
  /** The raw response, for fields the adapted Simulation leaves out (horizon totals). */
  raw: Record<string, unknown> | null;
}

/** Slot 1 is the current plan, slots 2 and 3 the first two plans the grower added. */
export function buildBoxes(baseline: Scenario, alternatives: Scenario[], data: Simulation | null, suggested: Record<string, string | null> = {}): BoxModel[] {
  const slots: Array<Scenario | null> = [baseline, alternatives[0] ?? null, alternatives[1] ?? null];
  return slots.map((scenario, i) => {
    const result = scenario ? (data?.scenarios.find((s) => s.scenarioId === scenario.scenarioId) ?? null) : null;
    const isSug = Boolean(scenario && scenario.scenarioId in suggested);
    return { slot: i, suggested: isSug, suggestedOrigin: isSug ? suggested[scenario!.scenarioId] : null, title: i === 0 ? "What I do now" : isSug ? `Suggested: ${scenario!.label}` : (scenario?.label ?? ""), scenario, result, monthly: scenario && data ? monthlyOf(data.raw, scenario.scenarioId) : null, raw: data?.raw ?? null };
  });
}

// ------------------------------------------------------------------ money summary
/** Money spent or earned over the whole horizon (median of per-run totals), as the backend sums it. */
function horizonTotal(raw: Record<string, unknown> | null, scenarioId: string, key: "costs_total" | "revenue_total"): number | null {
  const list = raw && Array.isArray(raw.scenarios) ? (raw.scenarios as Array<Record<string, unknown>>) : [];
  const totals = list.find((s) => s.scenario_id === scenarioId)?.totals as Record<string, { median?: unknown }> | undefined;
  const v = totals?.[key]?.median;
  return typeof v === "number" ? v : null;
}

const ASSUMPTION_LABEL: Record<string, string> = { dry_spring_pct: "dry-spring loss estimate", heavy_rain_pct: "heavy-rain loss estimate" };
const assumptionList = (v: string | string[] | null | undefined) => (v == null ? [] : Array.isArray(v) ? v : v.split("+"));

export function MoneySummary({ result, monthly, raw, onFinancial }: { result: ScenarioResult; monthly: ScenarioMonthly | null; raw: Record<string, unknown> | null; onFinancial: () => void }) {
  if (result.moneyStatus !== "complete") {
    return (
      <div className="sb-money" role="group" aria-label="Money">
        <p className="sb-gap-title">Money is not available for this plan yet.</p>
        {result.moneyGaps.length ? <ul className="sb-gaps">{result.moneyGaps.map((g, i) => <li key={i}>{g}</li>)}</ul> : <p className="gf-muted">Some money inputs are missing or still need checking.</p>}
        <button type="button" className="btn btn-secondary" onClick={onFinancial}>Open Financial Analysis</button>
      </div>
    );
  }
  const margin: Dist | null = (result.totals.margin_10y as Dist | null | undefined) ?? null;
  const cur = margin?.currency ?? monthly?.currency ?? result.yearly[0]?.money?.costs?.currency ?? null;
  const fmt = (v: number | null | undefined) => money(v, cur);
  const spent = horizonTotal(raw, result.scenarioId, "costs_total");
  const earned = horizonTotal(raw, result.scenarioId, "revenue_total");
  const flat = margin?.p10 != null && margin.p90 != null && margin.p10 === margin.p90;
  const assumed = assumptionList(monthly?.includes_assumption ?? margin?.includesAssumption);
  return (
    <div className="sb-money" role="group" aria-label="Money over 5 seasons">
      <dl className="sb-money-grid">
        <div><dt>Spent</dt><dd>{fmt(spent)}</dd><dd className="sb-prov"><OriginLabel origin="calculation" /></dd></div>
        <div><dt>Earned</dt><dd>{fmt(earned)}</dd><dd className="sb-prov"><OriginLabel origin="calculation" /></dd></div>
        <div className="sb-net"><dt>Net, typical run</dt><dd>{fmt(margin?.median)}</dd><dd className="sb-prov"><OriginLabel origin={(margin?.origin ?? "calculation") as Origin} /></dd></div>
      </dl>
      {flat ? (
        <>
          <p className="sb-range">Same in every replayed season: weather only changes money here through a loss estimate you enter. <OriginLabel origin="calculation" /></p>
          <button type="button" className="btn btn-secondary" onClick={onFinancial}>Add a loss estimate</button>
        </>
      ) : (
        <p className="sb-range">
          <span>Bad years {fmt(margin?.p10)}</span> <span aria-hidden="true">to</span><span className="sb-sr"> up to </span> <span>good years {fmt(margin?.p90)}</span>
          <span className="sb-prov"><OriginLabel origin="calculation" /></span>
        </p>
      )}
      <p className="gf-muted sb-small">
        Built from your own prices, yields and costs. <OriginLabel origin="grower" />
        {assumed.length ? <> Includes your {assumed.map((a) => ASSUMPTION_LABEL[a] ?? readable(a)).join(" and ")}. <OriginLabel origin="assumed" /></> : null}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ month-by-month chart
const monthName = (m: string, withYear = true) => {
  const [y, mo] = m.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(Date.UTC(y!, mo! - 1, 1)));
};
const OP_LABEL: Record<string, string> = { plant: "Plant", plant_grain: "Plant", harvest: "Harvest", harvest_grain: "Harvest", seed_cover: "Seed cover crop", end_cover: "End cover crop" };
const opLabel = (o: { kind: string; crop_id?: string | null }) => `${OP_LABEL[o.kind] ?? readable(o.kind)}${o.crop_id ? ` ${cropLabel(o.crop_id).toLowerCase()}` : ""}`;
const RISK_LABEL: Record<string, string> = { dry_pre_plant: "Dry before planting", heavy_rain_on_bare_soil: "Heavy rain on bare soil" };
const riskText = (r: { kind: string; probability?: number | null; text?: string | null }) => r.text || `${RISK_LABEL[r.kind] ?? readable(r.kind)}${r.probability != null ? ` in ${pct(r.probability)} of replays` : ""}`;

function OpMark({ kind, x, y }: { kind: string; x: number; y: number }) {
  const s = 4;
  if (kind.startsWith("plant")) return <polygon points={`${x},${y - s} ${x + s},${y + s} ${x - s},${y + s}`} className="sb-op" />;
  if (kind.startsWith("harvest")) return <rect x={x - s + 0.5} y={y - s + 0.5} width={2 * s - 1} height={2 * s - 1} className="sb-op" />;
  if (kind === "seed_cover") return <circle cx={x} cy={y} r={s} className="sb-op sb-op-open" />;
  return <polygon points={`${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`} className="sb-op sb-op-open" />;
}

const W = 360;
const PAD_L = 4;
const PAD_R = 4;
const PLOT_T = 12;
const PLOT_H = 130;
const AXIS_H = 16;
const OPS_ROW = 10;

export function MonthChart({ monthly, title }: { monthly: ScenarioMonthly; title: string }) {
  const months = monthly.months;
  const [active, setActive] = useState<number | null>(null);
  if (!months.length) return <p className="gf-muted">No month-by-month result for this plan.</p>;
  const cur = monthly.currency ?? null;
  const fmt = (v: number | null | undefined) => money(v, cur);
  const down = (m: MonthlyMonth) => (m.costs?.median != null ? -Math.abs(m.costs.median) : null);
  let lo = 0;
  let hi = 0;
  for (const m of months) {
    for (const v of [down(m), m.cumulative_net?.p10, m.cumulative_net?.median, m.cumulative_net?.p90, m.revenue?.median]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  const y = (v: number) => PLOT_T + ((hi - v) / (hi - lo)) * PLOT_H;
  const y0 = y(0);
  const slot = (W - PAD_L - PAD_R) / months.length;
  const cx = (i: number) => PAD_L + slot * (i + 0.5);
  const barW = Math.max(2, Math.min(18, slot * 0.6));
  const maxOps = Math.max(1, ...months.map((m) => m.operations.length));
  const opsTop = PLOT_T + PLOT_H + AXIS_H;
  const H = opsTop + maxOps * OPS_ROW + 6;
  const line = (key: "p10" | "median" | "p90") => months.flatMap((m, i) => (m.cumulative_net?.[key] != null ? [[cx(i), y(m.cumulative_net[key]!)] as const] : []));
  const pts = (a: ReadonlyArray<readonly [number, number]>) => a.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const upper = line("p90");
  const lower = line("p10");
  const hasBand = upper.length > 1 && upper.length === lower.length;
  const mid = line("median");
  const listedRisks = months.filter((m) => m.risks.length);
  // Only months whose highest risk reaches the display threshold are shaded; the list keeps them all.
  const shaded = months.map((m) => Math.max(0, ...m.risks.map((r) => r.probability ?? 0)) >= RISK_SHADE_MIN);
  const riskMonths = months.filter((_, i) => shaded[i]);
  const a = active != null ? months[active] : null;
  const labelAt = (m: MonthlyMonth, i: number) => (months.length <= 14 ? monthName(m.month, false) : i === 0 || m.month.endsWith("-01") ? m.month.slice(0, 4) : m.month.endsWith("-07") ? "Jul" : "");
  return (
    <figure className="sb-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: money by month. Costs are drawn below the zero line, revenue above it, with the running net as a line. ${riskMonths.length ? `${riskMonths.length} months are shaded for weather risk.` : ""} The month list below has every value.`} onMouseLeave={() => setActive(null)}>
        <rect x={0} y={0} width={W} height={H} className="sb-bg" />
        {months.map((_, i) => (shaded[i] ? <rect key={`r${i}`} x={PAD_L + slot * i} y={PLOT_T} width={slot} height={PLOT_H} className="sb-risk" /> : null))}
        <line x1={PAD_L} x2={W - PAD_R} y1={y0} y2={y0} className="sb-zero" />
        <text x={PAD_L + 2} y={y0 - 3} className="sb-axis-label">Revenue above</text>
        <text x={PAD_L + 2} y={y0 + 11} className="sb-axis-label">Costs below</text>
        {hasBand ? <polygon points={`${pts(upper)} ${pts([...lower].reverse())}`} className="sb-band" /> : null}
        {months.map((m, i) => (
          <g key={m.month}>
            {m.revenue?.median != null && m.revenue.median !== 0 ? <rect x={cx(i) - barW / 2} y={y(Math.max(m.revenue.median, 0))} width={barW} height={Math.max(1, Math.abs(y(m.revenue.median) - y0))} className="sb-rev" /> : null}
            {down(m) != null && down(m) !== 0 ? <rect x={cx(i) - barW / 2} y={y0} width={barW} height={Math.max(1, Math.abs(y(down(m)!) - y0))} className="sb-cost" /> : null}
          </g>
        ))}
        {mid.length > 1 ? <polyline points={pts(mid)} className="sb-line" /> : null}
        {months.map((_, i) => (shaded[i] ? <text key={`b${i}`} x={cx(i)} y={PLOT_T + 9} textAnchor="middle" className="sb-risk-mark">!</text> : null))}
        {months.map((m, i) => (
          <g key={`l${i}`}>
            <text x={cx(i)} y={PLOT_T + PLOT_H + 12} textAnchor="middle" className="sb-tick">{labelAt(m, i)}</text>
            {m.operations.map((o, k) => <OpMark key={k} kind={o.kind} x={cx(i)} y={opsTop + k * OPS_ROW + 5} />)}
          </g>
        ))}
        {months.map((m, i) => (
          <rect
            key={`h${i}`}
            x={PAD_L + slot * i}
            y={0}
            width={slot}
            height={H}
            className={`sb-hit${active === i ? " is-active" : ""}`}
            tabIndex={shaded[i] ? 0 : undefined}
            aria-label={shaded[i] ? `${monthName(m.month)}: ${m.risks.map(riskText).join("; ")}` : undefined}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          />
        ))}
      </svg>
      <figcaption className="sb-legend">
        <span><i className="sb-key sb-key-rev" />Revenue (above zero)</span>
        <span><i className="sb-key sb-key-cost" />Costs (below zero)</span>
        <span><i className="sb-key sb-key-line" />Running net, typical</span>
        <span><i className="sb-key sb-key-band" />Bad to good years</span>
        <span><i className="sb-key sb-key-risk" />! Shaded: weather risk in 1 of 10 replayed seasons or more</span>
        <span>Triangle plant, square harvest, circle seed cover, diamond end cover</span>
      </figcaption>
      <p className="sb-detail" aria-live="polite">
        {a ? (
          <>
            <strong>{monthName(a.month)}</strong>: spent {fmt(a.costs?.median != null ? Math.abs(a.costs.median) : null)}, earned {fmt(a.revenue?.median)}, running net {fmt(a.cumulative_net?.median)} (bad {fmt(a.cumulative_net?.p10)}, good {fmt(a.cumulative_net?.p90)}).
            {a.operations.length ? ` ${a.operations.map(opLabel).join(", ")}.` : ""}
            {a.risks.length ? ` Risk: ${a.risks.map(riskText).join("; ")}.` : ""}
          </>
        ) : (
          <span className="gf-muted">Hover a month, or tab to a flagged month, for its numbers.</span>
        )}
      </p>
      <details className="sb-list">
        <summary>Month by month, as a list</summary>
        <ul>
          {months.map((m) => (
            <li key={m.month}>
              <strong>{monthName(m.month)}</strong>: spent {fmt(m.costs?.median != null ? Math.abs(m.costs.median) : null)}, earned {fmt(m.revenue?.median)}, net {fmt(m.net?.median)}, running net {fmt(m.cumulative_net?.median)}.
              {m.operations.length ? ` ${m.operations.map(opLabel).join(", ")}.` : ""}
              {m.risks.length ? ` Risk: ${m.risks.map(riskText).join("; ")}.` : ""}
            </li>
          ))}
        </ul>
      </details>
      {listedRisks.length ? (
        <ul className="sb-risks" aria-label="Months with weather risk">
          {listedRisks.map((m) => <li key={m.month}><strong>{monthName(m.month)}</strong>: {m.risks.map(riskText).join("; ")}. <OriginLabel origin={(monthly.origin ?? "calculation") as Origin} /></li>)}
        </ul>
      ) : null}
      {monthly.timing_text ? <p className="gf-muted sb-small">{monthly.timing_text} <OriginLabel origin={(monthly.timing_origin ?? "assumed") as Origin} /></p> : null}
    </figure>
  );
}

// ------------------------------------------------------------------ one box
export interface StrategyBoxProps {
  box: BoxModel;
  badges: Array<{ badge: string; why: string }>;
  highlight: boolean;
  /** True while the shared request runs, so the box does not claim to be empty. */
  waiting: boolean;
  onTab: (t: string) => void;
  /** Adds a suggested plan to the grower's plans (as Recommendations does). */
  onAdd?: (scenario: Scenario) => void;
  canAdd?: boolean;
  /** The plan finder is still looking, so an empty box says so instead of prompting. */
  finding?: boolean;
}
export function StrategyBox({ box, badges, highlight, waiting, onTab, onAdd, canAdd = true, finding = false }: StrategyBoxProps) {
  const heading = <div className="db-card-head"><h3>{box.title || `Plan ${box.slot + 1}`}</h3></div>;
  if (!box.scenario)
    return (
      <section className="db-card sb-box sb-empty" aria-label={`Plan ${box.slot + 1}: empty`}>
        <div className="db-card-head"><h3>Plan {box.slot + 1}</h3></div>
        {finding ? (
          <p className="gf-muted" role="status">Finding suggested plans…</p>
        ) : (
          <>
            <p className="gf-muted">Pick a suggested plan to compare.</p>
            <button type="button" className="btn btn-secondary" onClick={() => onTab("recommendations")}>Open Recommendations</button>
          </>
        )}
      </section>
    );
  return (
    <section className={`db-card sb-box${highlight ? " sb-best" : ""}`} aria-label={box.title}>
      {heading}
      {box.suggested ? (
        <div className="sb-suggested">
          <span className="gf-muted sb-small">Suggested by the plan finder. {box.suggestedOrigin && box.suggestedOrigin in originLabels ? <OriginLabel origin={box.suggestedOrigin as Origin} /> : null}</span>
          <button type="button" className="btn btn-secondary" disabled={!canAdd} onClick={() => onAdd?.(box.scenario!)}>Add to my plans</button>
        </div>
      ) : null}
      {badges.length ? <ul className="sb-badges" aria-label="Where this plan comes out ahead">{badges.map((b, i) => <li key={i}>{b.badge}</li>)}</ul> : null}
      {box.result ? (
        <>
          <MoneySummary result={box.result} monthly={box.monthly} raw={box.raw} onFinancial={() => onTab("financial")} />
          {box.result.moneyStatus === "complete" ? (box.monthly ? <MonthChart monthly={box.monthly} title={box.title} /> : <p className="gf-muted">The month-by-month view is not available for this plan yet.</p>) : null}
        </>
      ) : waiting ? (
        <p className="gf-muted" role="status">Replaying this plan…</p>
      ) : (
        <>
          <p className="gf-muted">This plan is not complete yet, so it was not replayed. Finish its dates under Recommendations.</p>
          <button type="button" className="btn btn-secondary" onClick={() => onTab("recommendations")}>Open Recommendations</button>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ verdict row
const originLabels: Record<string, true> = { grower: true, verified_source: true, dataset_estimate: true, ai_suggested: true, source_checked: true, assumed: true, calculation: true, nasa_measured: true, nasa_modeled: true };
const badgeText = (b: string) => badgeLabels[b as keyof typeof badgeLabels] ?? readable(b).replace(/^./, (c) => c.toUpperCase());

export function VerdictRow({ boxes, data }: { boxes: BoxModel[]; data: Simulation }) {
  const c = data.comparison;
  if (!c) return null;
  const any = c.badges.length || c.tradeOffs.length || c.deltas.length;
  return (
    <section className="db-card sb-verdict" aria-label="How the plans compare">
      <div className="db-card-head"><h2>How the plans compare</h2></div>
      {any ? (
        <div className="sb-verdict-grid">
          {boxes.map((b) => {
            const id = b.scenario?.scenarioId;
            const mine = id ? c.badges.filter((x) => x.scenarioId === id) : [];
            const trade = id ? c.tradeOffs.filter((x) => x.scenarioId === id) : [];
            const deltas = id ? c.deltas.filter((d) => d.scenarioId === id).flatMap((d) => d.changes.filter((x) => x.text)) : [];
            return (
              <div key={b.slot} className={`sb-verdict-cell${mine.length ? " sb-best" : ""}`}>
                <h3>{b.scenario ? b.title : `Plan ${b.slot + 1}`}</h3>
                {!b.scenario ? <p className="gf-muted">Empty</p> : null}
                {mine.map((x, i) => <p key={`b${i}`}><strong>{badgeText(x.badge)}.</strong> {x.why}</p>)}
                {trade.map((x, i) => <p key={`t${i}`}>{x.text}</p>)}
                {deltas.map((x, i) => <p key={`d${i}`} className="gf-muted">{x.text}</p>)}
                {b.scenario && !mine.length && !trade.length && !deltas.length ? <p className="gf-muted">No standout result.</p> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="gf-muted">The service did not name a standout plan for these results.</p>
      )}
      {c.notDecided.length ? <ul className="sb-gaps">{c.notDecided.map((n, i) => <li key={i}>{n.badge ? `${badgeText(n.badge)}: ` : ""}{n.reasonText || "not decided"}</li>)}</ul> : null}
      <p className="gf-muted sb-small">{c.caveat}</p>
    </section>
  );
}

// ------------------------------------------------------------------ suggestions to fill empty boxes
/** A plan's identity for "is this the same plan": crops, dates and winter step, not ids or labels. */
const planSignature = (rotation: FieldPlan[]) =>
  JSON.stringify(rotation.map((p) => [p.previous_crop_id, p.next_crop_id, p.prev_harvest, p.next_plant, p.winter]));

const recCache = new Map<string, Recommendation>();
type RecState = { state: "idle" | "loading" | "error" } | { state: "ready"; data: Recommendation };

/** The plan finder's shortlist for this field and priorities, fetched like Recommendations does. */
function useShortlist(ctx: StepContext, enabled: boolean): RecState {
  const { field, sim, point } = ctx;
  const goalPriorities = Object.fromEntries(PRIORITY_NAMES.map((n) => [n, sim.priorities[n] ?? 0]));
  const key = JSON.stringify([point, goalPriorities, sim.equipment]);
  const [rec, setRec] = useState<RecState>(() => (recCache.has(key) ? { state: "ready", data: recCache.get(key)! } : { state: "idle" }));
  useEffect(() => {
    if (!enabled || !point || !field) return;
    const hit = recCache.get(key);
    if (hit) return setRec({ state: "ready", data: hit });
    let live = true;
    setRec({ state: "loading" });
    const ha = areaHa(field.geometry);
    void ctx.api.client
      .recommend({ point }, { priorities: goalPriorities }, { fieldId: field.field_id, areaHa: ha > 0 ? Math.round(ha * 100) / 100 : null, cropHistory: [], equipment: sim.equipment })
      .then((r) => {
        if (r.ok) recCache.set(key, r.data);
        if (live) setRec(r.ok ? { state: "ready", data: r.data } : { state: "error" });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return rec;
}

/** The top shortlisted plans, in the backend's order, skipping any that match the current plan or a plan already chosen. */
export function pickSuggestions(shortlist: Option[], current: FieldPlan[], taken: Scenario[], count: number): Array<{ scenario: Scenario; origin: string | null }> {
  const seen = new Set([planSignature(current), ...taken.map((s) => planSignature(s.rotation))]);
  const out: Array<{ scenario: Scenario; origin: string | null }> = [];
  for (const o of shortlist) {
    if (out.length >= count) break;
    const rotation = o.plans.map(asFieldPlan).filter((p): p is NonNullable<typeof p> => Boolean(p));
    if (!rotationReady(rotation) || rotation.length !== o.plans.length) continue;
    const sig = planSignature(rotation);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ scenario: { scenarioId: `sug_${o.candidateId}`, label: o.label, isBaseline: false, rotation, from: "suggested" }, origin: o.origin ?? null });
  }
  return out;
}

/** One line from the backend's own badge and trade-off sentences, naming the plan each belongs to. */
export function decisionSummary(boxes: BoxModel[], data: Simulation): string[] {
  const c = data.comparison;
  if (!c) return [];
  const titleOf = (id: string) => boxes.find((b) => b.scenario?.scenarioId === id)?.title ?? id;
  const badges = [...c.badges].sort((a, b) => Number(b.badge === "best_profit") - Number(a.badge === "best_profit")).filter((b) => b.why);
  const lines = badges.slice(0, 2).map((b) => `${titleOf(b.scenarioId)}: ${b.why}`);
  if (!lines.length) {
    const t = c.tradeOffs[0] ?? null;
    const d = c.deltas.flatMap((x) => x.changes.filter((y) => y.text).map((y) => ({ id: x.scenarioId, text: y.text })))[0];
    if (t) lines.push(`${titleOf(t.scenarioId)}: ${t.text}`);
    else if (d) lines.push(`${titleOf(d.id)}: ${d.text}`);
  }
  return lines;
}

// ------------------------------------------------------------------ the whole view
export function StrategyView({ ctx, onTab }: { ctx: StepContext; onTab: (t: string) => void }) {
  const { sim, field } = ctx;
  const own = sim.scenarios.slice(0, SLOTS - 1);
  const needMore = own.length < SLOTS - 1 && rotationReady(sim.rotation);
  const rec = useShortlist(ctx, needMore);
  const finding = needMore && (rec.state === "loading" || rec.state === "idle") && Boolean(ctx.point);
  const picks = needMore && rec.state === "ready" ? pickSuggestions(rec.data.shortlist, sim.rotation, sim.scenarios, SLOTS - 1 - own.length) : [];
  const alternatives = [...own, ...picks.map((p) => p.scenario)];
  const suggested = Object.fromEntries(picks.map((p) => [p.scenario.scenarioId, p.origin]));
  const base = simulateRequest(ctx, alternatives);
  // Hold the request until the plan finder has answered, so the boxes are simulated once.
  const req = base && !finding ? { ...base, years: HORIZON_YEARS } : null;
  const { sim: result, run } = useSimulation(ctx.api.client, req, true);
  const data = result.state === "ready" ? result.data : null;
  const baseline = base?.scenarios[0] ?? { scenarioId: "current", label: "What I do now", isBaseline: true, rotation: sim.rotation, from: "current" as const };
  const boxes = buildBoxes(baseline, alternatives, data, suggested);
  const badgesFor = (id: string | undefined) => (id && data?.comparison ? data.comparison.badges.filter((b) => b.scenarioId === id).map((b) => ({ badge: badgeText(b.badge), why: b.why })) : []);
  const years = data?.method.sourceYears;
  const summary = data ? decisionSummary(boxes, data) : [];
  const add = (s: Scenario) => field && sim.scenarios.length < MAX_ALTERNATIVES && updateSimField(field.field_id, (cur) => ({ scenarios: cur.scenarios.some((x) => x.scenarioId === s.scenarioId) ? cur.scenarios : [...cur.scenarios, s] }));
  return (
    <section className="sb" aria-label="Your strategies">
      <div className="sb-head">
        <h2>Your strategies, season by season</h2>
        <p className="gf-muted">{HORIZON_YEARS} seasons of past weather replayed{years ? ` (${years})` : ""}, not a forecast. Prices and costs stay at the values you entered.</p>
      </div>
      {!rotationReady(sim.rotation) ? (
        <section className="db-card">
          <p className="gf-muted">Set a complete crop rotation to see what each strategy spends and earns.</p>
          <button type="button" className="btn btn-secondary" onClick={() => onTab("rotation")}>Open Crop Rotation</button>
        </section>
      ) : !base ? (
        <section className="db-card">
          <p className="gf-muted">Finish your prices and costs to see what each strategy spends and earns.</p>
          <button type="button" className="btn btn-secondary" onClick={() => onTab("financial")}>Open Financial Analysis</button>
        </section>
      ) : (
        <>
          {finding ? <p className="gf-running" role="status">Finding suggested plans…</p> : <SimStatus sim={result} onRetry={run} what={`${base.scenarios.length} ${base.scenarios.length === 1 ? "plan" : "plans"}`} />}
          {summary.length ? (
            <p className="sb-summary"><strong>What this means.</strong> {summary.join(" ")} <OriginLabel origin="calculation" /></p>
          ) : null}
          <div className="sb-grid">
            {boxes.map((b) => {
              const bs = badgesFor(b.scenario?.scenarioId);
              return <StrategyBox key={b.slot} box={b} badges={bs} highlight={bs.length > 0} waiting={!finding && (result.state === "loading" || result.state === "idle")} finding={finding} canAdd={sim.scenarios.length < MAX_ALTERNATIVES} onAdd={add} onTab={onTab} />;
            })}
          </div>
          {data ? <VerdictRow boxes={boxes} data={data} /> : null}
          {data ? <p className="gf-muted sb-small">{data.method.note}{" "}<OriginLabel origin="calculation" /></p> : null}
        </>
      )}
    </section>
  );
}
