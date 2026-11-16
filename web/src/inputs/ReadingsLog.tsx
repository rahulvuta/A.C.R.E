import { useId, useState } from "react";
import { readingKinds, readingSchema, type Reading, type ReadingKind } from "./schema";
import { OriginLabel, display } from "./shared";
import { convert, getUnits, longDate, qtyText, rainToMm, rainUnit, tempToC, tempUnit } from "../ui/units";

export interface ReadingsLogProps { value: Reading[]; onChange: (value: Reading[]) => void }
export const readingLabels: Record<ReadingKind, { label: string; unit: string; explanation: string }> = {
  soil_ph: { label: "Soil pH / acidity", unit: "pH", explanation: "Enter the pH from your soil test. Crop-specific acidity limits are assessed separately." },
  soil_moisture_pct: { label: "Soil moisture", unit: "%", explanation: "Percent soil moisture as reported by your instrument; check its measurement method." },
  soil_moisture_vwc: { label: "Volumetric soil moisture", unit: "m³/m³", explanation: "Volumetric water content reported by your instrument, between 0 and 1." },
  rainfall_mm: { label: "Rainfall", unit: "mm", explanation: "Millimetres of rainfall you recorded for this date." },
  soil_temp_c: { label: "Soil temperature", unit: "°C", explanation: "Soil temperature you measured in degrees Celsius." },
  organic_matter_pct: { label: "Soil organic matter", unit: "%", explanation: "Organic matter percentage from your soil test; this is different from soil organic carbon." },
  salinity_ds_m: { label: "Soil salinity (ECe)", unit: "dS/m", explanation: "Electrical conductivity of a saturated soil paste extract (ECe). Other extraction methods need their own named condition." },
  custom: { label: "Other condition", unit: "", explanation: "Name the condition and unit exactly as measured. The AI checks published crop-specific ranges where available." },
  note: { label: "Field note", unit: "", explanation: "An observation you wrote about the field." },
};
/** The unit a reading is typed and shown in: the grower's own for rain and temperature, the reading's own otherwise. */
const unitOf = (kind: ReadingKind) => (kind === "rainfall_mm" ? rainUnit() : kind === "soil_temp_c" ? tempUnit() : readingLabels[kind].unit);
/** What a grower can read off a gauge, a soil test or their own eyes comes first; the rest is "from a lab report". */
const QUICK: Array<{ kind: ReadingKind; label: string }> = [{ kind: "rainfall_mm", label: "Rain I measured" }, { kind: "soil_ph", label: "Soil test pH" }, { kind: "note", label: "A note" }];
const LAB = readingKinds.filter(kind => !QUICK.some(q => q.kind === kind));
function ReadingsChart({ readings, kind }: { readings: Reading[]; kind: ReadingKind }) {
  const info = { ...readingLabels[kind], unit: unitOf(kind) };
  const points = readings.filter(reading => reading.kind === kind && reading.value !== null && Number.isFinite(reading.value)).sort((a, b) => a.date.localeCompare(b.date)).map(reading => ({ ...reading, value: Number(convert(reading.value!, readingLabels[kind].unit).value.toFixed(2)) }));
  if (!points.length) return null;
  const numbers = points.map(point => point.value!);
  const min = Math.min(0, ...numbers), max = Math.max(0, ...numbers);
  const span = max - min || 1;
  const firstTime = Date.parse(`${points[0]!.date}T00:00:00Z`), lastTime = Date.parse(`${points[points.length - 1]!.date}T00:00:00Z`);
  const x = (date: string) => lastTime === firstTime ? 320 : 65 + (Date.parse(`${date}T00:00:00Z`) - firstTime) / (lastTime - firstTime) * 510;
  const y = (number: number) => 160 - (number - min) / span * 125;
  return <figure className="acre-input-readings-chart"><figcaption>{info.label} ({info.unit}) <OriginLabel origin="grower" /></figcaption>
    <svg viewBox="0 0 640 215" role="img" aria-label={`${info.label} readings by date in ${info.unit}. Exact values are listed below.`}>
      <line x1="65" x2="575" y1="160" y2="160" stroke="#a7b2b6" /><line x1="65" x2="65" y1="35" y2="160" stroke="#a7b2b6" />
      <text x="55" y="40" textAnchor="end">{max}</text><text x="55" y="165" textAnchor="end">{min}</text>
      <polyline points={points.map(point => `${x(point.date)},${y(point.value!)}`).join(" ")} fill="none" stroke="#004656" strokeWidth="2" />
      {points.map((point, index) => <circle key={index} cx={x(point.date)} cy={y(point.value!)} r="4" fill="#004656"><title>{longDate(point.date)}: {point.value} {info.unit} · you entered</title></circle>)}
      <text x="65" y="195">{longDate(points[0]!.date)}</text>{points.length > 1 && <text x="575" y="195" textAnchor="end">{longDate(points[points.length - 1]!.date)}</text>}
    </svg><p className="acre-input-help">Each dot is a reading you entered; dates run from left to right.</p>
  </figure>;
}
export function ReadingsLog({ value, onChange }: ReadingsLogProps) {
  const id = useId();
  const units = getUnits();
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [kind, setKind] = useState<ReadingKind>("rainfall_mm");
  const [number, setNumber] = useState("");
  const [depth, setDepth] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [basis, setBasis] = useState<"saturation" | "volumetric" | "sensor_percent">("volumetric");
  const charted = (item: ReadingKind) => value.some(reading => reading.kind === item && reading.value !== null);
  const chartable = readingKinds.filter(item => item !== "note" && item !== "custom");
  const [chartKind, setChartKind] = useState<ReadingKind>(() => (charted("soil_moisture_pct") ? "soil_moisture_pct" : chartable.find(charted) ?? "rainfall_mm"));
  const [error, setError] = useState<string>();
  const lab = LAB.includes(kind);
  const pick = (next: ReadingKind) => { setKind(next); setNumber(""); setError(undefined); };
  function add() {
    // Rain and temperature are typed in the grower's units and kept in millimetres and °C.
    const typed = kind === "note" || number === "" ? null : Number(number);
    const stored = typed === null ? null : kind === "rainfall_mm" ? rainToMm(typed, units) : kind === "soil_temp_c" ? tempToC(typed, units) : typed;
    const parsed = readingSchema.safeParse({ date, kind, value: stored, depth_cm: !lab || depth === "" ? null : Number(depth), note: (kind === "note" || lab) && note.trim() ? note.trim() : undefined, ...(kind === "custom" ? { name: name.trim(), unit: unit.trim() } : {}), ...(kind === "soil_moisture_pct" ? { moisture_basis: basis } : {}), origin: "grower" });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(" ")); return; }
    onChange([...value, parsed.data]); setNumber(""); setNote(""); setError(undefined);
    if (kind !== "note" && kind !== "custom") setChartKind(kind);
  }
  const shown = (reading: Reading) => reading.kind === "custom" ? `${display(reading.value)}${reading.value !== null ? ` ${reading.unit}` : ""}` : (qtyText(reading.value, readingLabels[reading.kind].unit, units) ?? display(reading.value));
  return <section className="acre-inputs acre-input-card" aria-label="Field readings"><h2>Your field readings</h2><p>What you measure on this field is used ahead of the estimates for the area. Saved in this browser.</p>
    <fieldset><legend>Add a reading <OriginLabel origin="grower" /></legend>
      <div className="acre-input-quick" role="group" aria-label="What did you measure?">{QUICK.map(q => <button key={q.kind} type="button" className="acre-input-quick-btn" aria-pressed={kind === q.kind} onClick={() => pick(q.kind)}>{q.label}</button>)}</div>
      <details className="acre-input-lab" open={lab || undefined}><summary>From a lab report or a sensor</summary>
        <label>Reading type<select aria-label="Reading type" value={lab ? kind : ""} onChange={event => event.target.value && pick(event.target.value as ReadingKind)}><option value="">Choose a lab or sensor value</option>{LAB.map(item => <option key={item} value={item}>{readingLabels[item].label}{unitOf(item) ? ` (${unitOf(item)})` : ""}</option>)}</select></label>
      </details>
      <div className="acre-input-reading-fields">
        {kind === "custom" && <><label>Condition name<input maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="For example, available phosphorus" /></label><label>Measurement unit<input maxLength={30} value={unit} onChange={event => setUnit(event.target.value)} placeholder="For example, mg/kg" /></label></>}
        {kind === "soil_moisture_pct" && <label>Moisture measurement method<select value={basis} onChange={event => setBasis(event.target.value as typeof basis)}><option value="volumetric">Volumetric water content (%)</option><option value="saturation">Percent of saturation</option><option value="sensor_percent">Instrument percentage (uncalibrated)</option></select></label>}
        {kind !== "note" && <label>{readingLabels[kind].label} ({unitOf(kind)})<input type="number" step="any" min={kind === "soil_temp_c" ? undefined : 0} max={kind === "soil_moisture_pct" ? 100 : undefined} value={number} placeholder="Not available" onChange={event => setNumber(event.target.value)} aria-describedby={`${id}-explain`} /></label>}
        {lab && <label>Depth (cm, optional)<input type="number" min="0" max="300" step="any" value={depth} onChange={event => setDepth(event.target.value)} /></label>}
        {(kind === "note" || lab) && <label>Note{kind !== "note" ? " (optional)" : ""}<textarea maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>}
        <label>Date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      </div>
      <p className="acre-input-help" id={`${id}-explain`}>{kind === "rainfall_mm" ? `Rain you recorded for this date, in ${units.rain === "in" ? "inches" : "millimetres"}.` : kind === "soil_temp_c" ? `Soil temperature you measured, in ${tempUnit(units)}.` : readingLabels[kind].explanation}</p>{error && <p role="alert">{error}</p>}<button type="button" className="acre-input-primary" onClick={add}>Add reading</button></fieldset>
    {chartable.some(charted) ? <><label>Chart reading<select aria-label="Chart reading" value={chartKind} onChange={event => setChartKind(event.target.value as ReadingKind)}>{chartable.map(item => <option key={item} value={item}>{readingLabels[item].label} ({unitOf(item)})</option>)}</select></label>
    <ReadingsChart readings={value} kind={chartKind} /></> : null}
    {value.length ? <ul className="acre-input-readings-list" aria-label="Recorded readings">{value.map((reading, index) => <li key={index}><div><strong><time dateTime={reading.date}>{longDate(reading.date)}</time></strong> <OriginLabel origin={reading.origin} /><p>{reading.kind === "custom" ? <span translate="no">{reading.name}</span> : readingLabels[reading.kind].label}: {reading.kind === "note" ? <span translate="no">{display(reading.note)}</span> : shown(reading)}</p>{reading.depth_cm != null && <p>Depth: {reading.depth_cm} cm</p>}{reading.kind !== "note" && reading.note && <p translate="no">{reading.note}</p>}</div><button type="button" aria-label={`Remove ${readingLabels[reading.kind].label.toLowerCase()} on ${reading.date}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove</button></li>)}</ul> : null}
  </section>;
}
