import { useMemo, useState } from "react";
import { money, OUTLOOK_NOTE } from "./format";
import { buildRows } from "./schedule";
import { Gridlines, riskOf } from "./TenYearTimeline";
import { Legend, Track } from "./Track";
import type { TimelineScenario } from "./types";
import { yearSummary, YearTip } from "./YearTip";
import "./timeline.css";

/*
  2–6 scenarios stacked on one 10-year axis (card U4). Each lane is a scenario's crops year
  after year; the current plan is marked. Hover or focus a year for its margin and odds.
  The "best" verdicts live in the comparison view (U2); this only shows the plans in time.
*/
export interface TimelineCompareProps {
  scenarios: TimelineScenario[];
  riskAt?: number;
  note?: string;
}

export function TimelineCompare({ scenarios, riskAt = 0.3, note = OUTLOOK_NOTE }: TimelineCompareProps) {
  const shown = scenarios.slice(0, 6);
  const lanes = useMemo(() => shown.map((s) => ({ s, rows: buildRows(s.timeline, s.rotation ?? []), byYear: new Map(s.yearly.map((y) => [y.year, y])) })), [shown]);
  const years = lanes[0]?.rows.map((r) => r.year) ?? [];
  const n = Math.max(1, years.length);
  const [hover, setHover] = useState<{ lane: number; i: number } | null>(null);

  return (
    <section className="tl tl-compare" aria-label="Plans compared over 10 years">
      <div className="tl-cgrid" onMouseLeave={() => setHover(null)}>
        <div className="tl-lane tl-axis" aria-hidden="true">
          <span />
          <div className="tl-track tl-years">
            {years.map((y, i) => (
              <span key={y} style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }}>
                {y}
              </span>
            ))}
          </div>
        </div>
        {lanes.map(({ s, rows, byYear }, li) => {
          const total = s.totals?.margin_10y;
          return (
            <div key={s.scenario_id} className="tl-lane" data-scenario={s.scenario_id}>
              <div className="tl-lane-head">
                <p className="tl-lane-title">
                  {s.label}
                  {s.is_baseline ? <span className="tl-chip">Your current plan</span> : null}
                </p>
                <p className="tl-sub">{total ? `${money(total.median, total.currency)} over 10 years (median margin)` : "No money result"}</p>
              </div>
              <div className="tl-track tl-lane-track">
                <Gridlines count={n} />
                {rows.map((r, i) => {
                  const y = byYear.get(r.year);
                  const risk = riskOf(y);
                  const high = risk !== null && risk.p >= riskAt;
                  const active = hover?.lane === li && hover.i === i;
                  return (
                    <div
                      key={r.year}
                      className={`tl-cell${active ? " is-active" : ""}`}
                      style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }}
                      tabIndex={0}
                      aria-label={`${s.label}, ${yearSummary(r, y)}`}
                      onMouseEnter={() => setHover({ lane: li, i })}
                      onFocus={() => setHover({ lane: li, i })}
                      onBlur={() => setHover(null)}
                    >
                      {high ? <span className="tl-risk tl-risk-corner" title={`${risk!.what}: high odds`} /> : null}
                    </div>
                  );
                })}
                {rows.map((r, i) => (
                  <Track key={r.year} bands={r.bands} labels={false} span={[i / n, (i + 1) / n]} />
                ))}
                {hover?.lane === li ? <YearTip row={rows[hover.i]!} y={byYear.get(rows[hover.i]!.year)} x={(hover.i + 0.5) / n} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="tl-foot">
        <Legend risk={riskAt} />
        <p className="tl-note">{note}</p>
      </footer>
    </section>
  );
}
