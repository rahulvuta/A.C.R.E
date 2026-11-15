import { useEffect, useRef, useState } from "react";
import { CropPicker } from "./CropPicker";
import { inputsApi, type InputsApi } from "./api";
import { dateFields, monthDaySchema, type AutofillRequest, type Crop, type DateField, type InputLocation, type PlanDraft, type PlanEditorValue } from "./schema";
import { ErrorNotice, OriginLabel, SourceLabel, errorText } from "./shared";

/** `show`: the whole editor, only the crop choices, or only the dates (which then fill themselves in once when blank). */
export interface PlanEditorProps { location: InputLocation; value: PlanEditorValue; onChange: (value: PlanEditorValue) => void; regionKey?: string; api?: InputsApi; show?: "all" | "crops" | "dates" }
export function createPlanEditorValue(plan_id = "current"): PlanEditorValue {
  return { plan: { plan_id, previous_crop_id: null, prev_harvest: null, winter: { kind: "none" }, next_crop_id: null, next_plant: null }, dates: [], cropDetails: [] };
}
export function getPlanDate(plan: PlanDraft, field: DateField): string | null {
  if (field === "prev_harvest" || field === "next_plant") return plan[field];
  return plan.winter[field.slice(7) as "seed" | "terminate" | "plant" | "harvest"] ?? null;
}
function setDate(plan: PlanDraft, field: DateField, date: string | null): PlanDraft {
  return field === "prev_harvest" || field === "next_plant" ? { ...plan, [field]: date } : { ...plan, winter: { ...plan.winter, [field.slice(7)]: date } };
}
function DateInput({ field, label, value, onChange }: { field: DateField; label: string; value: PlanEditorValue; onChange: (value: PlanEditorValue) => void }) {
  const date = getPlanDate(value.plan, field);
  const evidence = value.dates.find(d => d.field === field && d.value === date);
  const [draft, setDraft] = useState(date ?? "");
  useEffect(() => {
    if (draft === "" || monthDaySchema.safeParse(draft).success) setDraft(date ?? "");
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalid = draft !== "" && !monthDaySchema.safeParse(draft).success;
  return <div className="acre-input-date"><label>{label}<input type="text" inputMode="numeric" placeholder="Not available" value={draft} aria-invalid={invalid} maxLength={5} onChange={event => {
    const text = event.target.value; setDraft(text);
    const next = monthDaySchema.safeParse(text).success ? text : null;
    onChange({ ...value, plan: setDate(value.plan, field, next), dates: [...value.dates.filter(d => d.field !== field), { field, value: next, origin: "grower" }] });
  }} /></label><p className="acre-input-help">Month and day (MM-DD); this date repeats each season.</p>
    {invalid ? <p role="alert">Use a valid MM-DD date, such as 04-20.</p> : <><OriginLabel origin={evidence?.origin} /><SourceLabel source={evidence?.source} /></>}
  </div>;
}
export function PlanEditor({ location, value, onChange, regionKey = value.plan.region ?? "", api = inputsApi, show = "all" }: PlanEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [gaps, setGaps] = useState<string[]>([]);
  const controller = useRef<AbortController>();
  const latest = useRef(value); latest.current = value;
  const cropKey = JSON.stringify([location, value.plan.previous_crop_id, value.plan.winter.kind, value.plan.winter.crop_id, value.plan.next_crop_id]);
  useEffect(() => { controller.current?.abort(); setLoading(false); setError(undefined); setGaps([]); return () => controller.current?.abort(); }, [cropKey, api]);
  function selected(id: string | null | undefined): Crop | null {
    return id ? value.cropDetails.find(crop => crop.crop_id === id) ?? { crop_id: id, name: id.replaceAll("_", " "), family: null, roles: [], origin: "grower" } : null;
  }
  function changeCrop(role: "previous" | "winter" | "next", crop: Crop | null) {
    let plan = { ...value.plan };
    if (role === "winter") plan.winter = { ...plan.winter, crop_id: crop?.crop_id ?? null, seed: null, terminate: null, plant: null, harvest: null };
    if (role === "previous") plan = { ...plan, previous_crop_id: crop?.crop_id ?? null, prev_harvest: null };
    if (role === "next") plan = { ...plan, next_crop_id: crop?.crop_id ?? null, next_plant: null };
    const dates = value.dates.filter(d => role === "winter" ? !d.field.startsWith("winter.") : d.field !== (role === "previous" ? "prev_harvest" : "next_plant"));
    onChange({ plan, dates, cropDetails: crop ? [...value.cropDetails.filter(c => c.crop_id !== crop.crop_id), crop] : value.cropDetails });
  }
  async function fill() {
    const startValue = value;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setLoading(true); setError(undefined); setGaps([]);
    const crops: AutofillRequest["crops"] = [];
    if (value.plan.previous_crop_id) crops.push({ role: "previous", crop_id: value.plan.previous_crop_id });
    if (value.plan.winter.kind !== "none" && value.plan.winter.crop_id) crops.push({ role: "cover", crop_id: value.plan.winter.crop_id });
    if (value.plan.next_crop_id) crops.push({ role: "next", crop_id: value.plan.next_crop_id });
    try {
      const response = await api.autofill({ location, crops }, current.signal);
      if (current.signal.aborted) return;
      // Preserve edits made while dates were loading, and never replace grower dates.
      let next = latest.current;
      for (const date of response.dates) {
        const relevant = date.field === "prev_harvest" || date.field === "next_plant" || next.plan.winter.kind === "cover" && ["winter.seed", "winter.terminate"].includes(date.field) || next.plan.winter.kind === "winter_grain" && ["winter.plant", "winter.harvest"].includes(date.field);
        const grower = next.dates.some(d => d.field === date.field && d.origin === "grower" && d.value !== null);
        if (relevant && !grower && getPlanDate(next.plan, date.field) === getPlanDate(startValue.plan, date.field)) next = { ...next, plan: setDate(next.plan, date.field, date.value), dates: [...next.dates.filter(d => d.field !== date.field), date] };
      }
      onChange(next); setGaps(response.gaps);
    } catch (error) { if (!current.signal.aborted) setError(errorText(error)); }
    finally { if (!current.signal.aborted) setLoading(false); }
  }
  const crops = show !== "dates";
  const dates = show !== "crops";
  const anyCrop = Boolean(value.plan.previous_crop_id || value.plan.winter.crop_id || value.plan.next_crop_id);
  const blankDate = dateFields.some(field => {
    const relevant = field === "prev_harvest" ? value.plan.previous_crop_id : field === "next_plant" ? value.plan.next_crop_id
      : value.plan.winter.kind === "cover" ? ["winter.seed", "winter.terminate"].includes(field) && value.plan.winter.crop_id
      : value.plan.winter.kind === "winter_grain" ? ["winter.plant", "winter.harvest"].includes(field) && value.plan.winter.crop_id : false;
    return relevant && !getPlanDate(value.plan, field);
  });
  // On the dates-only view, fill blank dates once per crop choice; dates already there (and the farmer's own) are kept.
  const autoFilled = useRef<string>();
  useEffect(() => {
    if (show !== "dates" || !anyCrop || !blankDate || autoFilled.current === cropKey) return;
    autoFilled.current = cropKey;
    void fill();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string | null | undefined) => selected(id)?.name ?? "Not chosen";
  return <section className="acre-inputs acre-input-card" aria-label={show === "dates" ? "Crop dates" : "Crop plan"}>
    {show === "all" && <h2>What do you grow?</h2>}
    <div className={show === "all" ? "acre-input-plan-grid" : "acre-input-plan-stack"}>
      <div>{crops && <><CropPicker label="Previous crop" regionKey={regionKey} api={api} value={selected(value.plan.previous_crop_id)} onChange={crop => changeCrop("previous", crop)} />{show === "crops" && <p className="acre-input-help">The main crop you harvest before winter.</p>}</>}
        {dates && <>{show === "dates" && <h3>{name(value.plan.previous_crop_id)}</h3>}<DateInput field="prev_harvest" label={show === "dates" ? "Harvest date" : "Previous harvest"} value={value} onChange={onChange} /></>}</div>
      <div>{crops && <><label>Winter use<select value={value.plan.winter.kind} onChange={event => onChange({ ...value, plan: { ...value.plan, winter: { kind: event.target.value as PlanDraft["winter"]["kind"], crop_id: null } }, dates: value.dates.filter(d => !d.field.startsWith("winter.")) })}><option value="none">Nothing (bare or stubble)</option><option value="cover">Cover crop</option><option value="winter_grain">Winter grain (harvested)</option></select></label>
        {show === "crops" && <p className="acre-input-help">What is on the field between the two crops.</p>}
        {value.plan.winter.kind !== "none" && <CropPicker label="Winter crop" regionKey={regionKey} api={api} value={selected(value.plan.winter.crop_id)} onChange={crop => changeCrop("winter", crop)} />}</>}
        {dates && value.plan.winter.kind !== "none" && show === "dates" && <h3>{name(value.plan.winter.crop_id)} <small>over winter</small></h3>}
        {dates && value.plan.winter.kind === "cover" && <><DateInput field="winter.seed" label="Cover seeding" value={value} onChange={onChange} /><DateInput field="winter.terminate" label="Cover end date" value={value} onChange={onChange} /></>}
        {dates && value.plan.winter.kind === "winter_grain" && <><DateInput field="winter.plant" label="Winter grain planting" value={value} onChange={onChange} /><DateInput field="winter.harvest" label="Winter grain harvest" value={value} onChange={onChange} /></>}
      </div>
      <div>{crops && <><CropPicker label="Next crop" regionKey={regionKey} api={api} value={selected(value.plan.next_crop_id)} onChange={crop => changeCrop("next", crop)} />{show === "crops" && <p className="acre-input-help">The main crop you plant after winter.</p>}</>}
        {dates && <>{show === "dates" && <h3>{name(value.plan.next_crop_id)}</h3>}<DateInput field="next_plant" label={show === "dates" ? "Planting date" : "Next planting"} value={value} onChange={onChange} /></>}</div>
    </div>
    {dates && <><button type="button" className={show === "dates" ? undefined : "acre-input-primary"} disabled={loading || !anyCrop} onClick={() => void fill()}>{show === "dates" ? "Refill blank dates with typical ones" : "Fill typical dates"}</button>
    <p className="acre-input-help">{show === "dates" ? "We filled in typical dates for this location. Change any that differ on your farm; your dates stay yours." : "Typical dates come from the service for this location; dates you enter stay yours."}</p>
    {loading && <p role="status">Looking up typical dates…</p>}{error && <ErrorNotice error={error} retry={() => void fill()} />}
    {!!gaps.length && <ul aria-label="Date gaps">{gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>}</>}
  </section>;
}
