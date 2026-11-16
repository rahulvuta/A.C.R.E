import { useEffect, useState, type ReactNode } from "react";
import type { Dist, ScenarioResult } from "../../api/simModel";
import { OriginBadge } from "../../ui/OriginBadge";
import { plainIds } from "../../ui/cropNames";
import { isDist, money, num } from "./format";
import { rainText } from "../../ui/units";
import { plainFacts, plainWords } from "./plainWords";

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

export interface PlainSentence {
  key: "dry" | "rain" | "money";
  text: string;
  origin: Dist["origin"] | null;
  note?: string;
  /** True for the money line when there is no money result: the page adds a way to the prices. */
  missing?: boolean;
  /** What the page shows in place of the sentence: one figure, a few words under it, and at most one small line more. */
  figure?: string;
  caption: string;
  extra?: string;
  /** Dots drawn for "N of M years": how many, and how many are filled. */
  dots?: { of: number; filled: number };
}

/** The three sentences as plain text: what step 3 shows and what the shared page and message carry (card 22). */
export function plainSentences(s: ScenarioResult): PlainSentence[] {
  const years = s.yearly.length || 10;
  const dry = dist(s.totals["dry_springs"]);
  const rain = dist(s.totals["rain_on_bare_soil_mm_per_year"]);
  const heavy = dist(s.totals["heavy_rain_days_on_bare_soil_per_year"]);
  const margin = dist(s.totals["margin_10y"]);
  // Planting is not always in spring (wheat after rice goes in in November), so the season is not named.
  const when = "the weeks before planting were";

  const rows: PlainSentence[] = [];
  // A crop that stays in the ground all year has no planting time and no bare ground: one sentence says so
  // in place of two zeros that would read as good news about weather that was never looked at.
  const covered = s.timeline.length > 0 && s.timeline.every((t) => t.ground === "permanent");
  if (covered) {
    rows.push({ key: "rain", origin: "calculation", figure: "All year", caption: "the ground stays covered", text: "The ground stays covered all year, so no rain falls on bare ground and there is no planting time to check." });
  } else if (dry?.median != null) {
    const spread = dry.p10 != null && dry.p90 != null && dry.p10 !== dry.p90 ? ` Across the runs it was between ${num(dry.p10)} and ${num(dry.p90)}.` : "";
    rows.push({
      key: "dry",
      origin: dry.origin,
      figure: `${num(dry.median)} of ${years}`,
      caption: "years too dry before planting",
      extra: dry.p10 != null && dry.p90 != null && dry.p10 !== dry.p90 ? `${num(dry.p10)} to ${num(dry.p90)} across the runs` : undefined,
      dots: { of: years, filled: Math.max(0, Math.min(years, Math.round(dry.median))) },
      text: dry.median === 0 ? `In a typical run, ${when} not too dry in any of the ${years} years.${spread}` : `In a typical run, ${when} too dry in ${num(dry.median)} of the ${years} years.${spread}`,
    });
  }
  if (!covered && rain?.median != null) {
    const heavyDays = heavy?.median != null && heavy.median > 0 ? num(heavy.median, null, 1) : null;
    const heavyText = heavyDays ? ` Heavy rain hits bare ground on about ${heavyDays} ${heavyDays === "1" ? "day" : "days"} a year.` : "";
    rows.push({
      key: "rain",
      origin: rain.origin,
      figure: rainText(rain.median),
      caption: "of rain a year on bare ground",
      extra: heavyDays ? `Heavy rain on about ${heavyDays} ${heavyDays === "1" ? "day" : "days"} a year` : undefined,
      text: `About ${rainText(rain.median)} of rain a year falls while the ground is bare.${heavyText}`,
    });
  }
  if (margin?.median != null) {
    const same = margin.p10 != null && margin.p90 != null && margin.p10 === margin.p90;
    const spread = margin.p10 != null && margin.p90 != null && !same ? ` Across the runs the ${years}-year figure ran from ${money(margin.p10, margin.currency)} to ${money(margin.p90, margin.currency)}.` : "";
    const flat = same && !margin.includesAssumption ? " Weather does not move this figure until you say how much a bad year costs you." : "";
    rows.push({
      key: "money",
      origin: margin.origin,
      // A margin that folds in the grower's own loss estimate says so, in place of the bare "Guess" label.
      note: margin.includesAssumption ? "Uses your loss estimate" : undefined,
      figure: money(margin.median / years, margin.currency),
      caption: "a year left after costs",
      extra: margin.p10 != null && margin.p90 != null && !same ? `${years} years: ${money(margin.p10, margin.currency)} to ${money(margin.p90, margin.currency)}` : `${years} years: ${money(margin.median, margin.currency)}`,
      text: `After the costs in your plan, it leaves about ${money(margin.median / years, margin.currency)} a year for the whole field (${money(margin.median, margin.currency)} over ${years} years).${spread}${flat}`,
    });
  } else if (s.nothingSold) {
    // Grazed land, or anything else nothing is sold from: no money result, and nothing to add.
    rows.push({ key: "money", origin: null, caption: "Nothing is sold from this field, so there is no money result.", text: "Nothing is sold from this field in the plan, so there is no money result." });
  } else {
    rows.push({
      key: "money",
      origin: null,
      missing: true,
      caption: "No money result yet.",
      extra: s.moneyGaps.length ? plainIds(s.moneyGaps[0]!) : "Each crop needs a price, a yield and at least one cost.",
      text: `There is no money result yet. ${s.moneyGaps.length ? s.moneyGaps.slice(0, 2).map((gap) => plainIds(gap)).join(" ") : "The plan needs a price, a yield and at least one cost for each crop."}`,
    });
  }
  return rows;
}

const ICON = { dry: DRY, rain: RAIN, money: MONEY } as const;

/** The same figures as the sentences above it, explained in one short paragraph by a model. Shown only when the service returned a checked answer. */
function PlainWords({ s, crops, twoCropsAYear }: { s: ScenarioResult; crops: string[]; twoCropsAYear: boolean }) {
  const body = plainFacts(s, crops, twoCropsAYear);
  const key = JSON.stringify(body);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setText(null);
    void plainWords(body).then((t) => {
      if (alive) setText(t);
    });
    return () => {
      alive = false;
    };
    // `key` is the whole request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!text) return null;
  return (
    <div className="pa-words" role="note" aria-label="In plain words, written by AI">
      <p>{text}</p>
      <p className="pa-words-by">
        <span className="ob ob-ai" title="Written by AI from the figures above. Every number in it was checked against them.">
          Written by AI
        </span>{" "}
        It uses only the figures above.
      </p>
    </div>
  );
}

export function PlainAnswer({ s, winter, onPrices, explain }: { s: ScenarioResult; winter: boolean; onPrices?: () => void; /** Asks for the model's plain-words paragraph (card 26); left out in tests and sample mode. */ explain?: { crops: string[]; twoCropsAYear?: boolean } }) {
  void winter;
  const rows = plainSentences(s).map((r) => ({ ...r, icon: ICON[r.key] }));
  const [words, setWords] = useState(false);

  return (
    <section className="db-card pa" aria-label="In short">
      <h2>In short</h2>
      {/* One figure and a few words each: the sentence form is kept for the shared page and for screen readers. */}
      <ul className="pa-rows">
        {rows.map((r) => (
          <li key={r.key} data-row={r.key} aria-label={r.text}>
            <span className="pa-icon">{r.icon}</span>
            <div className="pa-body">
              {r.figure ? <strong className="pa-figure">{r.figure}</strong> : null}
              <span className="pa-caption">{r.caption}</span>
              {r.dots ? (
                <span className="pa-dots" aria-hidden="true">
                  {Array.from({ length: r.dots.of }, (_, i) => (
                    <i key={i} data-on={i < r.dots!.filled ? "yes" : "no"} />
                  ))}
                </span>
              ) : null}
              {r.extra ? <span className="pa-extra">{r.extra}</span> : null}
              {r.missing && onPrices ? (
                <button type="button" className="btn btn-secondary pa-link" onClick={onPrices}>
                  Add prices and costs
                </button>
              ) : null}
              {r.note ? <span className="ob ob-assumed" data-origin={r.origin ?? undefined}>{r.note}</span> : r.origin ? <OriginBadge origin={r.origin} /> : null}
            </div>
          </li>
        ))}
      </ul>
      {/* The figures above are the answer. The paragraph in words is asked for, not shown to everyone (and is only written when asked). */}
      {explain ? (
        <details className="pa-more" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) setWords(true); }}>
          <summary>Say it in words</summary>
          {words ? <PlainWords s={s} crops={explain.crops} twoCropsAYear={Boolean(explain.twoCropsAYear)} /> : null}
        </details>
      ) : null}
      <p className="pa-note">From this field's real past weather. What to plan for, not a forecast.</p>
    </section>
  );
}
