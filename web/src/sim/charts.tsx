import { useId } from "react";
import type { Distribution, Reading } from "./schema";
import { formatNumber, OriginLabel, Value } from "./shared";

type Point = { x: number; value?: number | null; low?: number | null; high?: number | null; label: string };
const present = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

// Arithmetic here maps supplied values to SVG coordinates; it never derives a field result.
function Plot({ points, title, description, dots = false, band = false, unit, maximumGap }: {
  points: Point[]; title: string; description: string; dots?: boolean; band?: boolean; unit: string; maximumGap?: number;
}) {
  const id = useId();
  const valid = points.filter(p => Number.isFinite(p.x));
  const values = valid.flatMap(p => [p.value, ...(band ? [p.low, p.high] : [])]).filter(present);
  if (!values.length) return <p className="sim-chart-empty">Not available. No values were returned for this chart.</p>;
  const min = Math.min(...values), max = Math.max(...values);
  const first = Math.min(...valid.map(p => p.x)), last = Math.max(...valid.map(p => p.x));
  const x = (n: number) => first === last ? 360 : 76 + (n - first) / (last - first) * 560;
  const y = (n: number) => min === max ? 112 : 198 - (n - min) / (max - min) * 164;
  const splitSeries = (eligible: (point: Point) => boolean) => {
    const segments: Point[][] = [];
    let segment: Point[] = [];
    for (const point of valid) {
      const previous = segment.at(-1);
      if (previous && maximumGap != null && point.x - previous.x > maximumGap) {
        segments.push(segment);
        segment = [];
      }
      if (eligible(point)) segment.push(point);
      else if (segment.length) { segments.push(segment); segment = []; }
    }
    if (segment.length) segments.push(segment);
    return segments;
  };
  const segments = splitSeries(point => present(point.low) && present(point.high));
  const path = (items: Point[], field: "value" | "low" | "high") => items.map(p => `${x(p.x)},${y(p[field]!)}`).join(" ");
  // A separate series keeps the median visible even when a percentile is missing.
  const medians = splitSeries(point => present(point.value));
  return <svg className="sim-plot" viewBox="0 0 680 244" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
    <title id={`${id}-title`}>{title}</title><desc id={`${id}-desc`}>{description} Exact values and origins are listed below.</desc>
    <text x="76" y="17" className="sim-axis-label">{unit}</text>
    {[min, ...(max !== min ? [max] : [])].map(tick => <g key={tick}><line className="sim-grid-line" x1="76" x2="636" y1={y(tick)} y2={y(tick)} /><text x="66" y={y(tick) + 4} textAnchor="end">{formatNumber(tick)}</text></g>)}
    {band && segments.map((items, index) => <polygon key={index} className="sim-fan-band" points={`${path(items, "high")} ${path([...items].reverse(), "low")}`} />)}
    {!dots && medians.map((items, index) => <polyline key={index} className="sim-median-line" points={path(items, "value")} />)}
    {valid.filter(p => present(p.value)).map((p, index) => <circle className={dots ? "sim-grower-dot" : "sim-line-dot"} key={index} cx={x(p.x)} cy={y(p.value!)} r={dots ? 5 : 3}><title>{p.label}: {formatNumber(p.value)} {unit}</title></circle>)}
    {valid.map((p, index) => (valid.length <= 10 || index === 0 || index === valid.length - 1) && <text key={index} x={x(p.x)} y="226" textAnchor="middle">{p.label}</text>)}
  </svg>;
}

export interface FanChartProps { title: string; caption: string; rows: { year: number; distribution?: Distribution | null }[]; unit: string; money?: boolean }
export function FanChart({ title, caption, rows, unit, money = false }: FanChartProps) {
  const sorted = [...rows].sort((a, b) => a.year - b.year);
  const origins = [...new Set(rows.map(r => r.distribution?.origin))];
  return <section className="sim-card sim-fan-chart"><h3>{title}</h3><p>{caption}</p><Plot title={title} description="The line shows the median. The shaded band runs from p10 to p90, the middle 80% of historical replays. Gaps mean values are not available." band maximumGap={1} unit={unit} points={sorted.map(row => ({ x: row.year, label: String(row.year), value: row.distribution?.median, low: row.distribution?.p10, high: row.distribution?.p90 }))} /><div className="sim-chart-legend"><span><i className="sim-line-key" />Median</span><span><i className="sim-band-key" />p10–p90</span>{origins.map(origin => <OriginLabel key={origin ?? "missing"} origin={origin} />)}</div><p className="sim-muted">The shaded band holds the middle 80% of historical replays. Gaps mean a value is not available.</p><details><summary>See yearly values and origins</summary><div className="sim-table-scroll"><table><caption>{title}: values supplied by the simulation service</caption><thead><tr><th scope="col">Year</th><th scope="col">p10</th><th scope="col">Median</th><th scope="col">p90</th></tr></thead><tbody>{sorted.map(row => <tr key={row.year}><th scope="row">{row.year}</th>{(["p10", "median", "p90"] as const).map(key => <td key={key}><Value money={money} value={row.distribution?.[key]} currency={money ? row.distribution?.currency : undefined} unit={money ? undefined : row.distribution?.unit ?? unit} origin={row.distribution?.origin} /></td>)}</tr>)}</tbody></table></div></details></section>;
}

const readingKinds = {
  soil_moisture_pct: { label: "Farmer soil moisture", unit: "%", note: "Farmer dots show the moisture percentage entered for each date." },
  soil_moisture_vwc: { label: "Farmer volumetric soil moisture", unit: "m³/m³", note: "Farmer dots show the volumetric water content entered for each date." },
  rainfall_mm: { label: "Farmer rainfall", unit: "mm", note: "Farmer dots show the rainfall entered for each date." },
  soil_temp_c: { label: "Farmer soil temperature", unit: "°C", note: "Farmer dots show the soil temperature entered for each date." },
  note: { label: "Farmer note", unit: "", note: "Notes entered by the farmer." },
} as const;
export function ReadingsContext({ readings }: { readings: Reading[] }) {
  const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date));
  const kinds = [...new Set(sorted.filter(r => r.kind !== "note").map(r => r.kind))];
  const modeled = sorted.filter(r => r.modeled_same_day != null);
  return <section className="sim-card sim-readings"><h3>Your readings beside NASA context</h3><p>Farmer dots are field observations. The modeled line is NASA surface wetness for the weather cell; it is a different measure, shown on its own scale. Readings do not change the simulation.</p>{!readings.length ? <p className="sim-chart-empty">Not available. No field readings were returned.</p> : <><div className="sim-readings-grid">{kinds.map(kind => <div className="sim-reading-panel" key={kind}><h4>{readingKinds[kind].label}</h4><p>{readingKinds[kind].note}</p><Plot dots title={readingKinds[kind].label} description="Dots show the farmer's entered readings on their original scale." unit={readingKinds[kind].unit} points={sorted.filter(r => r.kind === kind).map(r => ({ x: Date.parse(r.date), label: r.date, value: typeof r.value === "number" ? r.value : null }))} /><div className="sim-chart-legend"><span><i className="sim-dot-key" />Farmer dots</span>{[...new Set(sorted.filter(r => r.kind === kind).map(r => r.origin))].map(origin => <OriginLabel key={origin ?? "missing"} origin={origin} />)}</div></div>)}<div className="sim-reading-panel"><h4>NASA modeled surface wetness</h4><p>The line shows a wetness index from 0 to 1, not a soil-moisture percentage or a field measurement.</p><Plot title="NASA modeled surface wetness" description="Line joins the modeled wetness values returned for reading dates; it does not show daily observations between dates." unit="wetness index" points={sorted.map(r => ({ x: Date.parse(r.date), label: r.date, value: r.modeled_same_day?.gwettop }))} /><p className="sim-muted">The line joins available reading dates; it does not supply observations between dates.</p><div className="sim-chart-legend"><span><i className="sim-line-key" />Modeled line</span>{[...new Set(modeled.map(r => r.modeled_same_day?.origin))].map(origin => <OriginLabel key={origin ?? "missing"} origin={origin} />)}</div></div></div><details><summary>See readings, depth, and modeled values</summary><div className="sim-table-scroll"><table><caption>Farmer observations and separate same-day NASA context</caption><thead><tr><th scope="col">Date</th><th scope="col">Farmer reading</th><th scope="col">Depth</th><th scope="col">NASA surface wetness</th></tr></thead><tbody>{sorted.map((r, index) => <tr key={`${r.date}-${index}`}><th scope="row">{r.date}</th><td>{readingKinds[r.kind].label}: {typeof r.value === "number" ? <Value value={r.value} unit={readingKinds[r.kind].unit} origin={r.origin} /> : <>{r.value || "Not available"}<OriginLabel origin={r.origin} /></>}{r.note && <p>{r.note}<OriginLabel origin={r.origin} /></p>}</td><td><Value value={r.depth_cm} unit="cm" origin={r.origin} /></td><td><Value value={r.modeled_same_day?.gwettop} unit="wetness index" origin={r.modeled_same_day?.origin} /></td></tr>)}</tbody></table></div></details></>}</section>;
}

export const chartMoneyUnit = (rows: { distribution?: Distribution | null }[]) => rows.find(r => r.distribution?.currency)?.distribution?.currency ?? "Currency not available";
