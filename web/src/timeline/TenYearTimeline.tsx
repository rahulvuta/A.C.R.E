import { useMemo, useState } from "react";
import { cropName } from "./crops";
import { money, moneyRange, pct, OUTLOOK_NOTE } from "./format";
import { buildRows, MONTHS, type Row } from "./schedule";
import { Legend, Track } from "./Track";
import type { TimelineScenario, YearResult } from "./types";
import { yearSummary, YearTip } from "./YearTip";
import "./timeline.css";

/*
  The 10-year plan as a calendar (card U4): one row per year, January to December, with the
  crops as coloured bands (cash crop, cover, bare ground), planting and harvest marks, and a
  small amber dot when the weather odds that year are high. Hover or focus a year for its
  margin and odds. Everything comes from the §11 response and the plan's own dates.
*/
export interface TenYearTimelineProps {
  scenario: TimelineScenario;
  /** Show the risk dot when a year's dry-before-planting or heavy-rain odds reach this share of simulated years. */
  riskAt?: number;
  /** The method note from the response (`method.note`). */
  note?: string;
  /** Hide the heading (when the page already names the scenario). */
  compact?: boolean;
}

export function riskOf(y: YearResult | undefined): { p: number; what: string } | null {
  const dry = y?.indicators?.dry_pre_plant?.probability ?? null;
  const heavy = y?.indicators?.heavy_rain_at_planting?.probability ?? null;
  if (dry === null && heavy === null) return null;
  return (dry ?? -1) >= (heavy ?? -1) ? { p: dry!, what: "Dry before planting" } : { p: heavy!, what: "Heavy rain at planting" };
}

export function TenYearTimeline({ scenario, riskAt = 0.3, note = OUTLOOK_NOTE, compact = false }: TenYearTimelineProps) {
  const rows = useMemo(() => buildRows(scenario.timeline, scenario.rotation ?? []), [scenario]);
  const byYear = useMemo(() => new Map(scenario.yearly.map((y) => [y.year, y])), [scenario]);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  const total = scenario.totals?.margin_10y;
  const range = moneyRange(total);
  const datesMissing = rows.some((r) => !r.datesKnown);

  return (
    <section className="tl" aria-label={`10-year plan: ${scenario.label}`}>
      {!compact ? (
        <header className="tl-head">
          <div>
            <h3 className="tl-title">{scenario.label}</h3>
            <p className="tl-sub">
              {rows.length} years, {rows[0]?.year}–{rows[rows.length - 1]?.year}
            </p>
          </div>
          {total ? (
            <div className="tl-total">
              <p className="tl-total-label">10-year margin, median</p>
              <p className="tl-total-value">{money(total.median, total.currency)}</p>
              {range ? <p className="tl-sub">Most years: {range}</p> : null}
            </div>
          ) : null}
        </header>
      ) : null}

      <div className="tl-grid" onMouseLeave={() => setHover(null)}>
        <div className="tl-row tl-axis" aria-hidden="true">
          <span />
          <span />
          <div className="tl-track tl-months">
            {MONTHS.map((m, i) => (
              <span key={m} style={{ left: `${(i / 12) * 100}%` }}>
                {m}
              </span>
            ))}
          </div>
          <span />
        </div>
        <ol className="tl-rows">
          {rows.map((r, i) => {
            const y = byYear.get(r.year);
            const risk = riskOf(y);
            const high = risk !== null && risk.p >= riskAt;
            return (
              <li
                key={r.year}
                className="tl-row"
                tabIndex={0}
                aria-label={yearSummary(r, y)}
                data-year={r.year}
                onFocus={() => setHover({ i, x: 0.7 })}
                onBlur={() => setHover(null)}
              >
                <span className="tl-year">{r.year}</span>
                <span className="tl-crop">{r.mainCrops.map(cropName).join(" + ") || "—"}</span>
                <div
                  className="tl-track"
                  onMouseEnter={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    setHover({ i, x: (e.clientX - box.left) / box.width });
                  }}
                  onMouseLeave={() => setHover((h) => (h?.i === i ? null : h))}
                  onMouseMove={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    setHover({ i, x: (e.clientX - box.left) / box.width });
                  }}
                >
                  <Gridlines />
                  <Track bands={r.bands} />
                  {hover?.i === i ? <YearTip row={r} y={y} x={hover.x} /> : null}
                </div>
                <span className="tl-risk-cell">{high ? <span className="tl-risk" title={`${risk!.what} in ${pct(risk!.p)} of simulated years`} /> : null}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <footer className="tl-foot">
        <Legend risk={riskAt} />
        {/* The compact timeline sits on a page that already says what the outlook is built on. */}
        {(!compact && note) || datesMissing ? (
          <p className="tl-note">
            {compact ? "" : note}
            {datesMissing ? " Some plans have no dates yet, so their crops are shown in order only." : ""}
          </p>
        ) : null}
      </footer>
    </section>
  );
}

export function Gridlines({ count = 12 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count - 1 }, (_, i) => (
        <span key={i} className="tl-gridline" style={{ left: `${((i + 1) / count) * 100}%` }} aria-hidden="true" />
      ))}
    </>
  );
}

export type { Row };
