import type { Comparison, Dist, ScenarioResult, Simulation } from "../../api/simModel";
import { OriginBadge } from "../../ui/OriginBadge";
import { BADGE_LABEL, cropLabel, indicatorLabel, isDist, isOdds, money, NA, num, pct, range } from "./format";

/*
  D's own views of a simulation (used until U2's components in web/src/sim are merged).
  They only select and format the backend's numbers: medians, ranges, odds, badges, deltas.
  Money and weather risk are shown side by side; a money value that folds in the farmer's
  loss estimate is labelled as their estimate.
*/

function MoneyValue({ d, label }: { d: Dist | null | undefined; label: string }) {
  if (!d || d.median == null) return <span className="gf-muted">{NA}</span>;
  const r = range(d, (v) => money(v, d.currency));
  return (
    <span className="gf-value">
      <strong className="gf-big">{money(d.median, d.currency)}</strong>
      {r ? <span className="gf-range">Range {r}</span> : null}
      <OriginBadge origin={d.origin} title={d.includesAssumption ? `${label}: uses your loss estimate (${d.includesAssumption.replace(/_/g, " ")})` : undefined} />
      {d.includesAssumption ? <span className="gf-assumed">Uses your loss estimate</span> : null}
    </span>
  );
}

function PlainValue({ d, digits = 0 }: { d: Dist | number | null | undefined; digits?: number }) {
  if (d == null) return <span className="gf-muted">{NA}</span>;
  if (typeof d === "number") return <strong className="gf-big">{num(d, null, digits)}</strong>;
  if (d.median == null) return <span className="gf-muted">{NA}</span>;
  const r = range(d, (v) => num(v, null, digits));
  return (
    <span className="gf-value">
      <strong className="gf-big">{num(d.median, d.unit, digits)}</strong>
      {r ? <span className="gf-range">Range {r}</span> : null}
      <OriginBadge origin={d.origin} />
    </span>
  );
}

export function MethodNote({ sim }: { sim: Simulation }) {
  const m = sim.method;
  return (
    <p className="gf-method">
      <strong>{m.note}</strong> {m.runs != null ? `Run ${m.runs} times` : null}
      {m.sourceYears ? ` with the seasons from ${m.sourceYears} in new orders` : null}
      {m.seed != null ? ` (seed ${m.seed}, so the same inputs give the same answer)` : null}.
    </p>
  );
}

/** One scenario's 10-year summary: money, soil and water, weather risk. */
export function ScenarioSummary({ s }: { s: ScenarioResult }) {
  const t = s.totals;
  const margin = isDist(t.margin_10y as Dist) ? (t.margin_10y as Dist) : null;
  return (
    <div className="gf-summary">
      <div className="gf-tiles">
        <div className="gf-tile">
          <span className="gf-tile-label">10-year margin (median)</span>
          {s.moneyStatus === "complete" || margin?.median != null ? <MoneyValue d={margin} label="10-year margin" /> : <span className="gf-muted">No money result</span>}
          {s.moneyGaps.length ? (
            <ul className="gf-gaps">
              {s.moneyGaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="gf-tile">
          <span className="gf-tile-label">Living cover a year</span>
          <PlainValue d={t.living_cover_days_per_year as Dist} />
        </div>
        <div className="gf-tile">
          <span className="gf-tile-label">Rain on bare soil a year</span>
          <PlainValue d={t.rain_on_bare_soil_mm_per_year as Dist} digits={0} />
        </div>
        <div className="gf-tile">
          <span className="gf-tile-label">Crop families · field passes a year</span>
          <span className="gf-value">
            <strong className="gf-big">
              {typeof t.crop_families === "number" ? t.crop_families : NA} · {typeof t.operations_per_year === "number" ? num(t.operations_per_year, null, 1) : NA}
            </strong>
          </span>
        </div>
      </div>
      {s.events.length ? (
        <div className="gf-events">
          <h3>Weather risk over 10 years</h3>
          <ul>
            {s.events.map((e) => (
              <li key={e.event}>
                <span className="gf-odds" aria-hidden="true">
                  <span style={{ width: `${Math.round((e.probability ?? 0) * 100)}%` }} />
                </span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {s.reasonText ? <p className="gf-muted">{s.reasonText}</p> : null}
    </div>
  );
}

/** Year by year: crops, margin and the soil and water indicators, as the backend gave them. */
export function YearTable({ s }: { s: ScenarioResult }) {
  const keys = [...new Set(s.yearly.flatMap((y) => Object.keys(y.indicators)))];
  const crops = new Map(s.timeline.map((t) => [t.year, t.cropSequence]));
  return (
    <div className="gf-scroll">
      <table className="gf-table gf-years">
        <caption className="sr-only">Year by year for {s.label}</caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">Crops</th>
            <th scope="col">Margin (median, range)</th>
            {keys.map((k) => (
              <th key={k} scope="col">
                {indicatorLabel(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.yearly.map((y) => {
            const m = y.money?.margin;
            return (
              <tr key={y.year}>
                <th scope="row">{y.year}</th>
                <td>{(crops.get(y.year) ?? []).map(cropLabel).join(" → ") || NA}</td>
                <td>
                  {m?.median != null ? money(m.median, m.currency) : NA}
                  {m ? <span className="gf-range"> {range(m, (v) => money(v, m.currency)) ?? ""}</span> : null}
                </td>
                {keys.map((k) => {
                  const v = y.indicators[k];
                  return <td key={k}>{isOdds(v) ? `${pct(v.probability)} of simulated years` : isDist(v) ? num(v.median, v.unit) : NA}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ReadingsBeside({ s }: { s: ScenarioResult }) {
  if (!s.readingsContext.length) return null;
  return (
    <div className="gf-readings-ctx">
      <h3>Your readings beside NASA's model</h3>
      <ul>
        {s.readingsContext.map((r) => (
          <li key={`${r.date}-${r.kind}`}>
            <span>
              {r.date} · {r.kind.replace(/_/g, " ")}: <strong>{r.value ?? NA}</strong>
            </span>
            <OriginBadge origin={r.origin} />
            {r.modeled.map((m) => (
              <span key={m.name} className="gf-muted">
                NASA modeled {m.name}: {m.value ?? NA} <OriginBadge origin={m.origin} />
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p className="gf-muted">Your measurements take precedence for matching field conditions. Compatible readings replace regional estimates on their recorded dates.</p>
    </div>
  );
}

/** Side-by-side columns with badges, reasons, deltas against the baseline and trade-offs. */
export function CompareColumns({ sim, chosenId, onChoose }: { sim: Simulation; chosenId: string | null; onChoose: (id: string) => void }) {
  const c: Comparison | null = sim.comparison;
  return (
    <div className="gf-compare">
      {c?.badges.length ? (
        <ul className="gf-badges" aria-label="Badges">
          {c.badges.map((b) => (
            <li key={b.badge}>
              <span className="gf-badge" data-badge={b.badge}>
                {BADGE_LABEL[b.badge] ?? b.badge}
              </span>
              <strong>{sim.scenarios.find((s) => s.scenarioId === b.scenarioId)?.label ?? b.scenarioId}</strong>
              <span>{b.why}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {c?.notDecided.length ? (
        <ul className="gf-gaps">
          {c.notDecided.map((n) => (
            <li key={n.badge}>
              {BADGE_LABEL[n.badge] ? `${BADGE_LABEL[n.badge]}: ` : ""}
              {n.reasonText || "Not decided for these plans."}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="gf-cols" style={{ gridTemplateColumns: `repeat(${sim.scenarios.length}, minmax(220px, 1fr))` }}>
        {sim.scenarios.map((s) => {
          const badges = c?.badges.filter((b) => b.scenarioId === s.scenarioId) ?? [];
          const delta = c?.deltas.find((d) => d.scenarioId === s.scenarioId);
          const trade = c?.tradeOffs.filter((t) => t.scenarioId === s.scenarioId) ?? [];
          const isBase = s.scenarioId === c?.baseline;
          return (
            <section key={s.scenarioId} className="gf-col" aria-label={s.label} data-chosen={chosenId === s.scenarioId ? "yes" : "no"}>
              <h3>
                {s.label}
                {isBase ? <span className="gf-muted"> · your current plan</span> : null}
              </h3>
              <div className="gf-col-badges">
                {badges.map((b) => (
                  <span key={b.badge} className="gf-badge" data-badge={b.badge}>
                    {BADGE_LABEL[b.badge] ?? b.badge}
                  </span>
                ))}
              </div>
              <ScenarioSummary s={s} />
              {delta?.changes.length ? (
                <div className="gf-delta">
                  <h4>Against your current plan</h4>
                  <ul>
                    {delta.changes.map((d) => (
                      <li key={d.indicator}>{d.text}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {trade.length ? (
                <div className="gf-trade">
                  <h4>What you give up</h4>
                  <ul>
                    {trade.map((t) => (
                      <li key={t.text}>{t.text}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <button type="button" className={chosenId === s.scenarioId ? "btn btn-primary" : "btn btn-secondary"} aria-pressed={chosenId === s.scenarioId} onClick={() => onChoose(s.scenarioId)}>
                {chosenId === s.scenarioId ? "Chosen" : "Choose this plan"}
              </button>
            </section>
          );
        })}
      </div>
      <p className="gf-caveat">{c?.caveat}</p>
    </div>
  );
}
