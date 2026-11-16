import type { FieldPlan } from "../farm/types";
import { type BandKind } from "./crops";
import type { TimelineEntry } from "./types";

/*
  Turns a 10-year timeline (contract §11 `timeline`) and the rotation's plan dates into
  calendar-year rows of bands: cash crop, cover, or fallow (bare ground), with planting and
  harvest marks. This only places the plan's own dates on a calendar; nothing is estimated.
  Without the plan's dates, a year's crops are shown in order with even widths and the row
  says the dates are not set.
*/
export type Mark = "plant" | "harvest" | "seed" | "terminate";

export interface Band {
  kind: BandKind;
  crop: string | null;
  /** 0..1 within the row (Jan 1 → Dec 31). */
  from: number;
  to: number;
  startMark: Mark | null;
  endMark: Mark | null;
  /** The real dates as "MM-DD", when known. */
  startDate: string | null;
  endDate: string | null;
}

export interface Row {
  year: number;
  season: string;
  bands: Band[];
  datesKnown: boolean;
  /** The cash crop(s) whose growing season sits mostly in this row, for the row's label. */
  mainCrops: string[];
  /** One crop stays in the ground all year: nothing is planted, so planting-time weather does not apply. */
  lasting?: boolean;
}

const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const parseMd = (md: string): [number, number] | null => {
  const m = /^(\d{2})-(\d{2})$/.exec(md);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
/** First moment on or after `after` that falls on month-day `md`. */
function next(md: string, after: number): number | null {
  const p = parseMd(md);
  if (!p) return null;
  const y = new Date(after).getUTCFullYear();
  for (const yy of [y, y + 1]) {
    const t = utc(yy, p[0], p[1]);
    if (t > after) return t;
  }
  return null;
}
const mdOf = (t: number) => {
  const d = new Date(t);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

interface Span {
  kind: BandKind;
  crop: string | null;
  start: number | null; // null = before the timeline starts
  end: number | null; // null = after it ends
  startMark: Mark | null;
  endMark: Mark | null;
}

/** All spans in order, or null when some plan's dates are missing or unreadable. */
function walk(entries: TimelineEntry[], plans: Map<string, FieldPlan>, startCursor: number): Span[] | null {
  const spans: Span[] = [];
  let cursor = startCursor;
  let cashStart: number | null = null;
  const push = (s: Span) => {
    if (s.start === null || s.end === null || s.end > s.start) spans.push(s);
  };
  for (const e of entries) {
    const p = plans.get(e.plan_id);
    if (!p) return null;
    const ph = next(p.prev_harvest, cursor);
    if (ph === null) return null;
    push({ kind: "cash", crop: p.previous_crop_id, start: cashStart, end: ph, startMark: cashStart === null ? null : "plant", endMark: "harvest" });
    let t = ph;
    const w = p.winter;
    if (w.kind === "cover" || w.kind === "winter_grain") {
      const a = next(w.kind === "cover" ? w.seed : w.plant, t);
      const b = a === null ? null : next(w.kind === "cover" ? w.terminate : w.harvest, a);
      if (a === null || b === null) return null;
      push({ kind: "fallow", crop: null, start: t, end: a, startMark: null, endMark: null });
      push(
        w.kind === "cover"
          ? { kind: "cover", crop: w.crop_id, start: a, end: b, startMark: "seed", endMark: "terminate" }
          : { kind: "cash", crop: w.crop_id, start: a, end: b, startMark: "plant", endMark: "harvest" },
      );
      t = b;
    }
    const np = next(p.next_plant, t);
    if (np === null) return null;
    push({ kind: "fallow", crop: null, start: t, end: np, startMark: null, endMark: null });
    cashStart = np;
    cursor = np;
  }
  const last = plans.get(entries[entries.length - 1]!.plan_id)!;
  push({ kind: "cash", crop: last.next_crop_id, start: cashStart, end: null, startMark: "plant", endMark: null });
  return spans;
}

export function buildRows(entries: TimelineEntry[], rotation: FieldPlan[] = []): Row[] {
  if (entries.length === 0) return [];
  const plans = new Map(rotation.map((p) => [p.plan_id, p]));
  const y0 = entries[0]!.year;
  // Start one year early, then shift so the first planting of the first plan lands in its season year.
  // The rotation goes on after the last year: walk one more plan so the last row is complete.
  const lastPlan = plans.get(entries[entries.length - 1]!.plan_id);
  const idx = lastPlan ? rotation.indexOf(lastPlan) : -1;
  const follow = idx >= 0 ? rotation[(idx + 1) % rotation.length]! : null;
  // Only when the next plan starts with the crop this one ends on (a one-plan "rotation" of
  // corn → soybean does not cycle back to corn).
  const extra = follow && lastPlan && follow.previous_crop_id === lastPlan.next_crop_id ? [{ year: entries[entries.length - 1]!.year + 1, season: "", crop_sequence: [], plan_id: rotation[(idx + 1) % rotation.length]!.plan_id }] : [];
  const walked = [...entries, ...extra];
  let spans = walk(walked, plans, utc(y0 - 1, 1, 1) - 1);
  if (spans) {
    // Shift by whole years so the first plan's planting lands in its season year.
    const first = plans.get(entries[0]!.plan_id)!;
    const firstPlant = spans.find((s) => s.kind === "cash" && s.startMark === "plant" && s.start !== null && s.crop === first.next_crop_id);
    const fy = firstPlant ? new Date(firstPlant.start!).getUTCFullYear() : y0;
    if (fy !== y0) spans = walk(walked, plans, utc(y0 - 1 - (fy - y0), 1, 1) - 1);
  }
  return entries.map((e, i) => withSystem(spans ? clipRow(spans, e) : evenRow(e, i), e, plans.get(e.plan_id)));
}

/** What the plan says beyond one crop after another: a crop grown together is named with the year's crop, and a crop that stays in the ground fills the whole year. */
function withSystem(row: Row, e: TimelineEntry, plan: FieldPlan | undefined): Row {
  if (e.ground === "permanent") {
    const crop = plan?.next_crop_id ?? e.crop_sequence[e.crop_sequence.length - 1] ?? null;
    const harvest = plan && /^\d{2}-\d{2}$/.test(plan.prev_harvest) && plan.permanent?.sold !== false ? plan.prev_harvest : null;
    return { ...row, bands: [{ kind: "cash", crop, from: 0, to: 1, startMark: null, endMark: null, startDate: null, endDate: harvest }], mainCrops: crop ? [crop] : [], lasting: true };
  }
  const mates = (e.companions ?? []).filter(Boolean);
  return mates.length ? { ...row, mainCrops: [...new Set([...row.mainCrops, ...mates])] } : row;
}

function clipRow(spans: Span[], e: TimelineEntry): Row {
  const a = utc(e.year, 1, 1);
  const b = utc(e.year + 1, 1, 1);
  const len = b - a;
  const bands: Band[] = [];
  const weight = new Map<string, number>();
  for (const s of spans) {
    const s0 = s.start ?? -Infinity;
    const s1 = s.end ?? Infinity;
    const lo = Math.max(s0, a);
    const hi = Math.min(s1, b);
    if (hi <= lo) continue;
    bands.push({
      kind: s.kind,
      crop: s.crop,
      from: (lo - a) / len,
      to: (hi - a) / len,
      startMark: s0 >= a ? s.startMark : null,
      endMark: s1 < b ? s.endMark : null,
      startDate: s.start !== null && s0 >= a ? mdOf(s.start) : null,
      endDate: s.end !== null && s1 < b ? mdOf(s.end - 0) : null,
    });
    if (s.kind === "cash" && s.crop) weight.set(s.crop, (weight.get(s.crop) ?? 0) + (hi - lo) / DAY);
  }
  // Name the crops planted in this row first; then any crop with a real share of the year.
  const planted = bands.filter((x) => x.kind === "cash" && x.startMark === "plant" && x.crop).map((x) => x.crop!);
  const main = planted.length ? planted : [...weight.entries()].sort((x, y) => y[1] - x[1]).slice(0, 1).map(([c]) => c);
  return { year: e.year, season: e.season, bands, datesKnown: true, mainCrops: [...new Set(main)] };
}

/** No dates: the year's crops in order, even widths. Middle crops of a three-crop year are the winter crop. */
function evenRow(e: TimelineEntry, _i: number): Row {
  const seq = e.crop_sequence;
  const n = Math.max(1, seq.length);
  const bands: Band[] = seq.map((c, i) => ({
    kind: seq.length === 3 && i === 1 ? "cover" : "cash",
    crop: c,
    from: i / n,
    to: (i + 1) / n,
    startMark: null,
    endMark: null,
    startDate: null,
    endDate: null,
  }));
  return { year: e.year, season: e.season, bands, datesKnown: false, mainCrops: seq.length ? [seq[seq.length - 1]!] : [] };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "05-12" → "May 12". */
export function formatMd(md: string | null): string {
  const p = md ? parseMd(md) : null;
  return p ? `${MONTHS[p[0] - 1]} ${p[1]}` : "";
}
export { MONTHS };
