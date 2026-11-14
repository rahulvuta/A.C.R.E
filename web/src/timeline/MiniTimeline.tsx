import { useMemo } from "react";
import type { FieldPlan } from "../farm/types";
import { cropName } from "./crops";
import { buildRows } from "./schedule";
import { Gridlines } from "./TenYearTimeline";
import { Track } from "./Track";
import { yearSummary } from "./YearTip";
import "./timeline.css";

/*
  One year of a field's plan as a thin strip, January to December (field cards, card U4).
  The plan's own dates only; the next season's crop is assumed to repeat the plan.
*/
export function MiniTimeline({ plan, year = new Date().getFullYear() + 1 }: { plan: FieldPlan; year?: number }) {
  const row = useMemo(() => buildRows([{ year, season: String(year), crop_sequence: [], plan_id: plan.plan_id }], [plan])[0] ?? null, [plan, year]);
  if (!row) return null;
  return (
    <div className="tl-mini" role="img" aria-label={yearSummary(row, undefined)}>
      <div className="tl-track tl-mini-track">
        <Gridlines />
        <Track bands={row.bands} labels={false} />
      </div>
      <div className="tl-mini-axis" aria-hidden="true">
        <span>Jan</span>
        <span>Jul</span>
        <span>Dec</span>
      </div>
    </div>
  );
}

/** "Corn → cereal rye (cover) → soybean". */
export function planCrops(plan: FieldPlan | null): string {
  if (!plan) return "No crops yet";
  const w = plan.winter;
  const mid = w.kind === "cover" ? `${cropName(w.crop_id).toLowerCase()} (cover)` : w.kind === "winter_grain" ? cropName(w.crop_id).toLowerCase() : "bare winter";
  return `${cropName(plan.previous_crop_id)} → ${mid} → ${cropName(plan.next_crop_id).toLowerCase()}`;
}
