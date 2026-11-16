import type { ReactNode } from "react";
import type { Dist, ScenarioResult } from "../../api/simModel";
import { OriginBadge } from "../../ui/OriginBadge";
import { plainIds } from "../../ui/cropNames";
import { isDist, money, num } from "./format";

/*
  The result of a 10-year run in three plain sentences: dry planting seasons, rain on bare
  ground, money. Every figure is one the service returned (a median, or the ends of its
  range); nothing is judged or combined here, and each sentence carries where its figure came
  from. A sentence whose figure is missing says so, or is left out.
*/
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const icon = (body: ReactNode) => (
  <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" {...stroke}>
    {body}
  </svg>
);
const DRY = icon(<><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.600 5.600l1.400 1.400M17 17l1.400 1.400M18.400 5.600L17 7M7 17l-1.400 1.400" /></>);
const RAIN = icon(<><path d="M7.500 14a4 4 0 0 1 .300-8 5 5 0 0 1 9.500 1.400A3.300 3.300 0 0 1 17 14z" /><path d="M9 17v2.500M12 17v4M15 17v2.500" /></>);
const MONEY = icon(<><circle cx="12" cy="12" r="8.500" /><path d="M14.500 9.500c-.500-1-1.400-1.500-2.500-1.500-1.500 0-2.500.800-2.500 2s1 1.700 2.500 2 2.500.800 2.500 2-1 2-2.500 2c-1.200 0-2.100-.500-2.600-1.500M12 6.500v11" /></>);

const dist = (x: Dist | number | null | undefined | unknown): Dist | null => (isDist(x as Dist) ? (x as Dist) : null);

export function PlainAnswer({ s, winter, onPrices }: { s: ScenarioResult; winter: boolean; onPrices?: () => void }) {
  const years = s.yearly.length || 10;
  const dry = dist(s.totals["dry_springs"]);
  const rain = dist(s.totals["rain_on_bare_soil_mm_per_year"]);
  const heavy = dist(s.totals["heavy_rain_days_on_bare_soil_per_year"]);
  const margin = dist(s.totals["margin_10y"]);
  const when = winter ? "the weeks before planting in spring were" : "the weeks before planting were";

  const rows: Array<{ key: string; icon: ReactNode; text: ReactNode; origin: Dist["origin"] | null; note?: string }> = [];
  if (dry?.median != null) {
    const spread = dry.p10 != null && dry.p90 != null && dry.p10 !== dry.p90 ? ` Across the runs it was between ${num(dry.p10)} and ${num(dry.p90)}.` : "";
    rows.push({
      key: "dry",
      icon: DRY,
      origin: dry.origin,
      text: dry.median === 0 ? `In a typical run, ${when} not too dry in any of the ${years} years.${spread}` : `In a typical run, ${when} too dry in ${num(dry.median)} of the ${years} years.${spread}`,
    });
  }
  if (rain?.median != null) {
    const heavyDays = heavy?.median != null && heavy.median > 0 ? num(heavy.median, null, 1) : null;
    const heavyText = heavyDays ? ` Heavy rain hits bare ground on about ${heavyDays} ${heavyDays === "1" ? "day" : "days"} a year.` : "";
    rows.push({ key: "rain", icon: RAIN, origin: rain.origin, text: `About ${num(rain.median)} mm of rain a year falls while the ground is bare.${heavyText}` });
  }
  if (margin?.median != null) {
    const same = margin.p10 != null && margin.p90 != null && margin.p10 === margin.p90;
    const spread = margin.p10 != null && margin.p90 != null && !same ? ` Across the runs the ${years}-year figure ran from ${money(margin.p10, margin.currency)} to ${money(margin.p90, margin.currency)}.` : "";
    const flat = same && !margin.includesAssumption ? " Weather does not move this figure until you say how much a bad year costs you." : "";
    rows.push({
      key: "money",
      icon: MONEY,
      origin: margin.origin,
      // A margin that folds in the grower's own loss estimate says so, in place of the bare "Guess" label.
      note: margin.includesAssumption ? "Uses your loss estimate" : undefined,
      text: `After the costs in your plan, it leaves about ${money(margin.median / years, margin.currency)} a year for the whole field (${money(margin.median, margin.currency)} over ${years} years).${spread}${flat}`,
    });
  } else {
    rows.push({
      key: "money",
      icon: MONEY,
      origin: null,
      text: (
        <>
          There is no money result yet. {s.moneyGaps.length ? s.moneyGaps.slice(0, 2).map((gap) => plainIds(gap)).join(" ") : "The plan needs a price, a yield and at least one cost for each crop."}{" "}
          {onPrices ? (
            <button type="button" className="btn btn-quiet pa-link" onClick={onPrices}>
              Add prices and costs
            </button>
          ) : null}
        </>
      ),
    });
  }

  return (
    <section className="db-card pa" aria-label="In short">
      <h2>In short</h2>
      <ul className="pa-rows">
        {rows.map((r) => (
          <li key={r.key} data-row={r.key}>
            <span className="pa-icon">{r.icon}</span>
            <p>
              {r.text} {r.note ? <span className="ob ob-assumed" data-origin={r.origin ?? undefined}>{r.note}</span> : r.origin ? <OriginBadge origin={r.origin} /> : null}
            </p>
          </li>
        ))}
      </ul>
      <p className="pa-note">Worked out from this field's real past weather. It shows what to plan for; it cannot say what any single year will bring.</p>
    </section>
  );
}
