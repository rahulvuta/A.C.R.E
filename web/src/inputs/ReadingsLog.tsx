import { useId, useState } from "react";
import { readingKinds, readingSchema, type Reading, type ReadingKind } from "./schema";
import { OriginLabel, display } from "./shared";

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
function ReadingsChart({ readings, kind }: { readings: Reading[]; kind: ReadingKind }) {
  const points = readings.filter(reading => reading.kind === kind && reading.value !== null && Number.isFinite(reading.value)).sort((a, b) => a.date.localeCompare(b.date));
  const info = readingLabels[kind];
  if (!points.length) return <p>{info.label} chart: Not available</p>;
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
      {points.map((point, index) => <circle key={index} cx={x(point.date)} cy={y(point.value!)} r="4" fill="#004656"><title>{point.date}: {point.value} {info.unit} · grower</title></circle>)}
      <text x="65" y="195">{points[0]!.date}</text>{points.length > 1 && <text x="575" y="195" textAnchor="end">{points[points.length - 1]!.date}</text>}
    </svg><p className="acre-input-help">Each dot is a reading you entered; dates run from left to right.</p>
  </figure>;
}
export function ReadingsLog({ value, onChange }: ReadingsLogProps) {
  const id = useId();
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [kind, setKind] = useState<ReadingKind>("soil_ph");
  const [number, setNumber] = useState("");
  const [depth, setDepth] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [basis, setBasis] = useState<"saturation" | "volumetric" | "sensor_percent">("volumetric");
  const [chartKind, setChartKind] = useState<ReadingKind>("soil_moisture_pct");
  const [error, setError] = useState<string>();
  function add() {
    const parsed = readingSchema.safeParse({ date, kind, value: kind === "note" || number === "" ? null : Number(number), depth_cm: depth === "" ? null : Number(depth), note: note.trim() || undefined, ...(kind === "custom" ? { name: name.trim(), unit: unit.trim() } : {}), ...(kind === "soil_moisture_pct" ? { moisture_basis: basis } : {}), origin: "grower" });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(" ")); return; }
    onChange([...value, parsed.data]); setNumber(""); setNote(""); setError(undefined);
    if (kind !== "note" && kind !== "custom") setChartKind(kind);
  }
  return <section className="acre-inputs acre-input-card" aria-label="Field readings"><h2>Your field readings</h2><p>Your measurements take precedence for this field. Leave a condition blank to use its local baseline. Entries are saved in this browser.</p>
    <fieldset><legend>Add a reading <OriginLabel origin="grower" /></legend><div className="acre-input-reading-fields">
      <label>Date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      <label>Reading type<select aria-label="Reading type" value={kind} onChange={event => { setKind(event.target.value as ReadingKind); setNumber(""); setError(undefined); }}>{readingKinds.map(item => <option key={item} value={item}>{readingLabels[item].label}{readingLabels[item].unit ? ` (${readingLabels[item].unit})` : ""}</option>)}</select></label>
      {kind === "custom" && <><label>Condition name<input maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="For example, available phosphorus" /></label><label>Measurement unit<input maxLength={30} value={unit} onChange={event => setUnit(event.target.value)} placeholder="For example, mg/kg" /></label></>}
      {kind === "soil_moisture_pct" && <label>Moisture measurement method<select value={basis} onChange={event => setBasis(event.target.value as typeof basis)}><option value="volumetric">Volumetric water content (%)</option><option value="saturation">Percent of saturation</option><option value="sensor_percent">Instrument percentage (uncalibrated)</option></select></label>}
      {kind !== "note" && <label>{readingLabels[kind].label} ({readingLabels[kind].unit})<input type="number" step="any" min={kind === "soil_temp_c" ? undefined : 0} max={kind === "soil_moisture_pct" ? 100 : undefined} value={number} placeholder="Not available" onChange={event => setNumber(event.target.value)} aria-describedby={`${id}-explain`} /></label>}
      {kind !== "note" && <label>Depth (cm, optional)<input type="number" min="0" max="300" step="any" value={depth} onChange={event => setDepth(event.target.value)} /></label>}
      <label>Note{kind !== "note" ? " (optional)" : ""}<textarea maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
    </div><p className="acre-input-help" id={`${id}-explain`}>{readingLabels[kind].explanation}</p>{error && <p role="alert">{error}</p>}<button type="button" className="acre-input-primary" onClick={add}>Add reading</button></fieldset>
    <label>Chart reading<select aria-label="Chart reading" value={chartKind} onChange={event => setChartKind(event.target.value as ReadingKind)}>{readingKinds.filter(item => item !== "note" && item !== "custom").map(item => <option key={item} value={item}>{readingLabels[item].label} ({readingLabels[item].unit})</option>)}</select></label>
    <ReadingsChart readings={value} kind={chartKind} />
    {value.length ? <ul className="acre-input-readings-list" aria-label="Recorded readings">{value.map((reading, index) => <li key={index}><div><strong>{reading.date}</strong> <OriginLabel origin={reading.origin} /><p>{reading.kind === "custom" ? reading.name : readingLabels[reading.kind].label}: {reading.kind === "note" ? display(reading.note) : <>{display(reading.value)}{reading.value !== null && ` ${reading.kind === "custom" ? reading.unit : readingLabels[reading.kind].unit}`}</>}</p>{reading.depth_cm != null && <p>Depth: {reading.depth_cm} cm</p>}{reading.kind !== "note" && reading.note && <p>{reading.note}</p>}</div><button type="button" aria-label={`Remove ${readingLabels[reading.kind].label.toLowerCase()} on ${reading.date}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove</button></li>)}</ul> : <p>No readings yet. Unknown readings can stay blank.</p>}
  </section>;
}
