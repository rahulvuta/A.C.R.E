import { useEffect, useState } from "react";
import type { FieldPlan } from "../../farm/types";
import { asPercent, canReadPictures, median, newestDays, readSmap, smapOnDay, smapSpans, SMAP_ROOT, type SmapYear } from "../../soil/smap";
import { OriginBadge } from "../../ui/OriginBadge";
import { LOCALE, longDate } from "../../ui/units";

/*
  Soil moisture at planting time, seen from space (card 31). The 10-year outlook decides
  "planting time too dry" from a weather model's wetness for an area about 50 km across.
  NASA's SMAP satellite has watched soil moisture since 2015 on squares about 9 km across.
  This card shows what SMAP had on the plan's planting day in each of those years, and the
  newest reading. It is a second look at the same place and changes no result.

  The value is read in the browser from NASA's published map picture (see soil/smap.ts), so no
  request names the field.
*/
const BADGE = "NASA's SMAP satellite readings combined with NASA's land model, on squares about 9 km across.";

/** "15 March": the day a "03-15" stands for, with the month in words. */
export function dayWords(monthDay: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(monthDay);
  if (!m) return monthDay;
  const month = new Intl.DateTimeFormat(LOCALE, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2001, Number(m[1]) - 1, 1)));
  return `${Number(m[2])} ${month}`;
}

/** The planting day the card is about: the first season with a planting. A crop that stays in the ground has none. */
export function plantingDay(rotation: FieldPlan[]): { monthDay: string; cropId: string } | null {
  const leg = rotation.find((p) => !p.permanent && /^\d{2}-\d{2}$/.test(p.next_plant) && p.next_crop_id);
  return leg ? { monthDay: leg.next_plant, cropId: leg.next_crop_id } : null;
}

export interface SoilNow {
  date: string;
  value: number;
}
const W = 360;
const H = 132;
function Bars({ years, mid, day }: { years: SmapYear[]; mid: number; day: string }) {
  const top = Math.max(0.1, ...years.map((y) => y.value)) * 1.18;
  const slot = (W - 8) / years.length;
  const bar = Math.min(22, slot * 0.62);
  const y = (v: number) => H - 20 - (v / top) * (H - 36);
  const low = Math.min(...years.map((r) => r.value));
  return (
    <svg className="sm-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Soil moisture on ${day} in each year: ${years.map((r) => `${r.year}, ${asPercent(r.value)}`).join("; ")}.`}>
      <line x1="4" x2={W - 4} y1={y(mid)} y2={y(mid)} className="sm-mid" />
      {years.map((r, i) => {
        const x = 4 + i * slot + (slot - bar) / 2;
        return (
          <g key={r.year} className={r.value === low ? "sm-bar sm-bar-low" : "sm-bar"}>
            <rect x={x} y={y(r.value)} width={bar} height={H - 20 - y(r.value)} rx="2" />
            <text x={x + bar / 2} y={y(r.value) - 4} textAnchor="middle" className="sm-val">
              {Math.round(r.value * 100)}
            </text>
            <text x={x + bar / 2} y={H - 6} textAnchor="middle" className="sm-year">
              {years.length > 8 ? `’${String(r.year).slice(2)}` : r.year}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function SoilMoistureCard({ years, now, monthDay, crop }: { years: SmapYear[]; now: SoilNow | null; monthDay: string; crop: string }) {
  if (years.length < 3) return null;
  const day = dayWords(monthDay);
  const values = years.map((y) => y.value);
  const mid = median(values);
  const low = years.reduce((a, b) => (b.value < a.value ? b : a));
  const high = years.reduce((a, b) => (b.value > a.value ? b : a));
  const nearby = years.some((y) => y.date.slice(5) !== (monthDay === "02-29" ? "02-28" : monthDay));
  return (
    <section className="db-card sm" aria-label="Soil moisture at planting time">
      <h2>Soil moisture at planting time, seen from space</h2>
      <div className="sm-head">
        <strong>{asPercent(mid)}</strong>
        <span className="sm-what">
          water in the top metre of soil on {day}, when you plant {crop}: the middle value of {years.length} years
        </span>
        <OriginBadge origin="nasa_modeled" title={BADGE} />
      </div>
      <Bars years={years} mid={mid} day={day} />
      <p className="sm-line">
        Driest: <span translate="no">{low.year}</span> ({asPercent(low.value)}). Wettest: <span translate="no">{high.year}</span> ({asPercent(high.value)}).
        {now ? ` Newest reading, ${longDate(now.date)}: ${asPercent(now.value)}.` : ""}
      </p>
      <p className="gf-muted">
        From NASA's SMAP satellite, combined with NASA's land model, for the 9 km square around your field: the land around it, not a reading from your soil.{nearby ? " Where NASA has no picture for the day, the nearest day is used." : ""} The 10-year outlook above still uses the weather
        model's wetness, so this changes no result.
      </p>
    </section>
  );
}

/** Reads and shows the card; shows nothing until there are at least three years to show. */
export function SoilMoisture({ point, rotation, cropName }: { point: { latitude: number; longitude: number }; rotation: FieldPlan[]; cropName: (id: string) => string }) {
  const plan = plantingDay(rotation);
  const [got, setGot] = useState<{ key: string; years: SmapYear[]; now: SoilNow | null } | null>(null);
  // One reading per 9 km or so, and per planting day.
  const key = plan ? `${point.latitude.toFixed(1)}|${point.longitude.toFixed(1)}|${plan.monthDay}` : "";
  useEffect(() => {
    if (!plan || !canReadPictures()) return;
    let alive = true;
    void (async () => {
      const years = await smapOnDay(plan.monthDay, point);
      const newest = newestDays(await smapSpans(SMAP_ROOT), 1)[0];
      const value = newest ? await readSmap(SMAP_ROOT, newest, point) : null;
      if (alive) setGot({ key, years, now: newest && value != null ? { date: newest, value } : null });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!plan || !got || got.key !== key) return null;
  return <SoilMoistureCard years={got.years} now={got.now} monthDay={plan.monthDay} crop={cropName(plan.cropId).toLowerCase()} />;
}
