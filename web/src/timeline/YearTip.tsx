import { bandFill, cropName } from "./crops";
import { money, moneyRange, pct } from "./format";
import { formatMd, type Row } from "./schedule";
import type { YearResult } from "./types";

/** What one year holds, in words: the hover card and the row's text alternative. */
export function yearSummary(row: Row, y: YearResult | undefined): string {
  const parts: string[] = [`${row.year}:`];
  const cash = row.bands.filter((b) => b.kind !== "fallow");
  parts.push(
    cash
      .map((b) => {
        const d = [b.startDate ? `${b.kind === "cover" ? "seeded" : "planted"} ${formatMd(b.startDate)}` : null, b.endDate ? `${b.kind === "cover" ? "ended" : "harvested"} ${formatMd(b.endDate)}` : null].filter(Boolean).join(", ");
        return `${cropName(b.crop)}${b.kind === "cover" ? " (cover)" : ""}${d ? ` ${d}` : ""}`;
      })
      .join("; ") + ".",
  );
  if (!row.datesKnown) parts.push("Dates not set.");
  const m = y?.money?.margin;
  if (m) parts.push(`Margin median ${money(m.median, m.currency)}.`);
  const dry = y?.indicators?.dry_pre_plant?.probability;
  if (dry != null) parts.push(`Dry before planting in ${pct(dry)} of simulated years.`);
  return parts.join(" ");
}

export function YearTip({ row, y, x }: { row: Row; y: YearResult | undefined; x: number }) {
  const m = y?.money?.margin;
  const range = moneyRange(m);
  const ind = y?.indicators;
  const dry = ind?.dry_pre_plant?.probability;
  const heavy = ind?.heavy_rain_at_planting?.probability;
  const bare = ind?.rain_on_bare_soil_mm?.median;
  const living = ind?.living_cover_days?.median;
  return (
    <div className="tl-tip" role="tooltip" style={{ left: `${Math.min(Math.max(x, 0), 1) * 100}%` }}>
      <p className="tl-tip-year">{row.year}</p>
      <ul className="tl-tip-crops">
        {row.bands
          .filter((b) => b.kind !== "fallow")
          .map((b, i) => (
            <li key={i}>
              <span className="tl-swatch" style={{ background: bandFill(b.kind, b.crop) }} aria-hidden="true" />
              <span>
                {cropName(b.crop)}
                {b.kind === "cover" ? " (cover)" : ""}
              </span>
              <span className="tl-tip-dates">
                {b.startDate ? formatMd(b.startDate) : row.datesKnown ? "earlier" : ""}
                {row.datesKnown ? " – " : ""}
                {b.endDate ? formatMd(b.endDate) : row.datesKnown ? "later" : ""}
              </span>
            </li>
          ))}
      </ul>
      {!row.datesKnown ? <p className="tl-tip-note">Dates not set for this plan.</p> : null}
      <dl className="tl-tip-stats">
        <div>
          <dt>Margin (median)</dt>
          <dd className="tl-tip-money">{m ? money(m.median, m.currency) : "Not available"}</dd>
        </div>
        {range ? (
          <div>
            <dt>Most years</dt>
            <dd>{range}</dd>
          </div>
        ) : null}
        {dry != null ? (
          <div>
            <dt>Dry before planting</dt>
            <dd>{pct(dry)} of simulated years</dd>
          </div>
        ) : null}
        {heavy != null ? (
          <div>
            <dt>Heavy rain at planting</dt>
            <dd>{pct(heavy)} of simulated years</dd>
          </div>
        ) : null}
        {bare != null ? (
          <div>
            <dt>Rain on bare soil</dt>
            <dd>{Math.round(bare)} mm (median)</dd>
          </div>
        ) : null}
        {living != null ? (
          <div>
            <dt>Living cover</dt>
            <dd>{Math.round(living)} days (median)</dd>
          </div>
        ) : null}
      </dl>
      {m?.includes_assumption ? <p className="tl-tip-note">Includes your own loss estimate for dry springs.</p> : null}
      <p className="tl-tip-note">Calculated from this field's past NASA weather, run forward in many orders.</p>
    </div>
  );
}
