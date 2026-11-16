import { useEffect, useRef, useState } from "react";
import { CropPicker } from "./CropPicker";
import { inputsApi, type InputsApi } from "./api";
import { dateFields, monthDaySchema, type AutofillRequest, type CalendarResearchEntry, type Crop, type DateField, type InputLocation, type PlanDraft, type PlanEditorValue } from "./schema";
import { ErrorNotice, OriginLabel, SourceLabel, errorText, pauseFor } from "./shared";
import { hasWinter, plainIds, tidyCropName, worldCropName } from "../ui/cropNames";

/* Crop + region pairs a date lookup was started for in this page session; remounting the editor must not start them again. */
const startedDateLookups = new Set<string>();
export function resetCalendarLookupsForTests() { startedDateLookups.clear(); }
const POLL_MS = 2000;
const MAX_POLLS = 90;
type DatePhase = { state: "running" } | { state: "finished" } | { state: "stopped" } | { state: "failed"; message: string };
type FillInfo = { regionKey: string; entries: CalendarResearchEntry[] };

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
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const two = (n: number) => String(n).padStart(2, "0");
/** "10-15" as "15 October": the day first and the month by name, so it reads the same everywhere. */
export function plainDate(monthDay: string | null | undefined): string {
  const m = monthDay ? /^(\d{2})-(\d{2})$/.exec(monthDay) : null;
  return m ? `${Number(m[2])} ${MONTH_NAMES[Number(m[1]) - 1] ?? ""}`.trim() : "";
}
/** A date as two lists, day and month by name. Nothing is typed, so 03-10 can never be read as 10 March by one grower
 *  and 3 October by another. The value kept is still MM-DD, and it stays blank until both are chosen. */
function DateInput({ field, label, value, onChange }: { field: DateField; label: string; value: PlanEditorValue; onChange: (value: PlanEditorValue) => void }) {
  const date = getPlanDate(value.plan, field);
  const evidence = value.dates.find(d => d.field === field && d.value === date);
  const [month, setMonth] = useState(date ? date.slice(0, 2) : "");
  const [day, setDay] = useState(date ? date.slice(3) : "");
  useEffect(() => {
    if (date) { setMonth(date.slice(0, 2)); setDay(date.slice(3)); }
    else if (month && day) { setMonth(""); setDay(""); } // cleared from outside (the crop changed)
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (m: string, d: string) => {
    const most = m ? MONTH_DAYS[Number(m) - 1]! : 31;
    const dd = d && Number(d) > most ? two(most) : d;
    setMonth(m); setDay(dd);
    const text = m && dd ? `${m}-${dd}` : null;
    const next = text && monthDaySchema.safeParse(text).success ? text : null;
    onChange({ ...value, plan: setDate(value.plan, field, next), dates: [...value.dates.filter(x => x.field !== field), { field, value: next, origin: "grower" }] });
  };
  const most = month ? MONTH_DAYS[Number(month) - 1]! : 31;
  const half = (month || day) && !(month && day);
  return <fieldset className="acre-input-date" data-value={date ?? ""}><legend>{label}</legend>
    <div className="acre-input-date-row">
      <select aria-label={`${label}: day`} value={day} onChange={event => commit(month, event.target.value)}>
        <option value="">Day</option>
        {Array.from({ length: most }, (_, i) => <option key={i} value={two(i + 1)}>{i + 1}</option>)}
      </select>
      <select aria-label={`${label}: month`} value={month} onChange={event => commit(event.target.value, day)}>
        <option value="">Month</option>
        {MONTH_NAMES.map((name, i) => <option key={name} value={two(i + 1)}>{name}</option>)}
      </select>
    </div>
    <p className="acre-input-help">{date ? `${plainDate(date)}, every year.` : half ? "Pick both the day and the month." : "Pick the day and the month. It repeats every year."}</p>
    {evidence?.origin ? <><OriginLabel origin={evidence.origin} /><SourceLabel source={evidence.source} /></> : null}
  </fieldset>;
}
export function PlanEditor({ location, value, onChange, regionKey = value.plan.region ?? "", api = inputsApi, show = "all" }: PlanEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [gaps, setGaps] = useState<string[]>([]);
  const [info, setInfo] = useState<FillInfo | null>(null);
  const [phases, setPhases] = useState<Record<string, DatePhase>>({});
  const lookupController = useRef<AbortController>();
  const runningKey = useRef<string | null>(null);
  const controller = useRef<AbortController>();
  const latest = useRef(value); latest.current = value;
  const cropKey = JSON.stringify([location, value.plan.previous_crop_id, value.plan.winter.kind, value.plan.winter.crop_id, value.plan.next_crop_id]);
  useEffect(() => {
    controller.current?.abort(); setLoading(false); setError(undefined); setGaps([]); setInfo(null); setPhases(previous => Object.keys(previous).length ? {} : previous);
    return () => {
      controller.current?.abort();
      // A lookup cut short by a change of crops or by leaving the page may start again; a finished, failed or stopped one may not.
      lookupController.current?.abort(); lookupController.current = undefined;
      if (runningKey.current) { startedDateLookups.delete(runningKey.current); runningKey.current = null; }
    };
  }, [cropKey, api]);
  function selected(id: string | null | undefined): Crop | null {
    return id ? value.cropDetails.find(crop => crop.crop_id === id) ?? { crop_id: id, name: worldCropName(id), family: null, roles: [], origin: "grower" } : null;
  }
  function changeCrop(role: "previous" | "winter" | "next", crop: Crop | null) {
    let plan = { ...value.plan };
    if (role === "winter") plan.winter = { ...plan.winter, crop_id: crop?.crop_id ?? null, seed: null, terminate: null, plant: null, harvest: null };
    if (role === "previous") plan = { ...plan, previous_crop_id: crop?.crop_id ?? null, prev_harvest: null };
    if (role === "next") plan = { ...plan, next_crop_id: crop?.crop_id ?? null, next_plant: null };
    const dates = value.dates.filter(d => role === "winter" ? !d.field.startsWith("winter.") : d.field !== (role === "previous" ? "prev_harvest" : "next_plant"));
    onChange({ plan, dates, cropDetails: crop ? [...value.cropDetails.filter(c => c.crop_id !== crop.crop_id), crop] : value.cropDetails });
  }
  async function fill(): Promise<boolean> {
    const startValue = latest.current;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setLoading(true); setError(undefined); setGaps([]);
    const crops: AutofillRequest["crops"] = [];
    if (startValue.plan.previous_crop_id) crops.push({ role: "previous", crop_id: startValue.plan.previous_crop_id });
    if (startValue.plan.winter.kind !== "none" && startValue.plan.winter.crop_id) crops.push({ role: "cover", crop_id: startValue.plan.winter.crop_id });
    if (startValue.plan.next_crop_id) crops.push({ role: "next", crop_id: startValue.plan.next_crop_id });
    try {
      const response = await api.autofill({ location, crops }, current.signal);
      if (current.signal.aborted) return false;
      // Preserve edits made while dates were loading, and never replace grower dates.
      let next = latest.current;
      for (const date of response.dates) {
        const relevant = date.field === "prev_harvest" || date.field === "next_plant" || next.plan.winter.kind === "cover" && ["winter.seed", "winter.terminate"].includes(date.field) || next.plan.winter.kind === "winter_grain" && ["winter.plant", "winter.harvest"].includes(date.field);
        const grower = next.dates.some(d => d.field === date.field && d.origin === "grower" && d.value !== null);
        if (relevant && !grower && getPlanDate(next.plan, date.field) === getPlanDate(startValue.plan, date.field)) next = { ...next, plan: setDate(next.plan, date.field, date.value), dates: [...next.dates.filter(d => d.field !== date.field), date] };
      }
      onChange(next); setGaps(response.gaps);
      setInfo(response.research?.available && response.research.region_key ? { regionKey: response.research.region_key, entries: response.calendar_research ?? [] } : null);
      return true;
    } catch (error) { if (!current.signal.aborted) setError(errorText(error)); return false; }
    finally { if (!current.signal.aborted) setLoading(false); }
  }
  async function startDateLookup(cropId: string, refresh = false) {
    const regionForLookup = info?.regionKey;
    if (!regionForLookup) return;
    lookupController.current?.abort();
    const lookup = new AbortController(); lookupController.current = lookup;
    const { signal } = lookup;
    const started = `${cropId}|${regionForLookup}`;
    startedDateLookups.add(started); runningKey.current = started;
    setPhases(previous => ({ ...previous, [cropId]: { state: "running" } }));
    try {
      let job = await (refresh ? api.calendarResearch(cropId, regionForLookup, signal, true) : api.calendarResearch(cropId, regionForLookup, signal));
      for (let poll = 0; job.job_status === "pending"; poll++) {
        if (poll >= MAX_POLLS) throw new Error("The lookup is taking longer than expected. You can try again.");
        await pauseFor(signal, POLL_MS);
        job = await api.calendarResearchJob(job.job_id, signal);
      }
      if (signal.aborted) return;
      if (job.job_status === "failed") { runningKey.current = null; setPhases(previous => ({ ...previous, [cropId]: { state: "failed", message: job.reason_text || "The lookup did not finish." } })); return; }
      await fill(); // asks for the dates again; the same rules keep the farmer's own dates
      if (signal.aborted) return;
      runningKey.current = null;
      setPhases(previous => ({ ...previous, [cropId]: { state: "finished" } }));
    } catch (error) {
      if (signal.aborted) return;
      runningKey.current = null;
      setPhases(previous => ({ ...previous, [cropId]: { state: "failed", message: errorText(error) } }));
    }
  }
  function stopDateLookup(cropId: string) {
    lookupController.current?.abort(); lookupController.current = undefined; runningKey.current = null;
    setPhases(previous => ({ ...previous, [cropId]: { state: "stopped" } }));
  }
  const activeId = Object.keys(phases).find(id => phases[id]!.state === "running");
  const wantsDateLookup = (entry: CalendarResearchEntry) => !!info && entry.missing && !entry.researched_at && !startedDateLookups.has(`${entry.crop_id}|${info.regionKey}`);
  // One crop at a time, in the order the service lists them.
  useEffect(() => {
    if (!info || activeId || loading) return;
    const next = info.entries.find(wantsDateLookup);
    if (next) void startDateLookup(next.crop_id);
    // wantsDateLookup and startDateLookup close over info, api and location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, activeId, loading]);
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
  // Near the equator there is no winter: the three boxes are a first crop, what is on the field after it, and the next crop.
  const winter = hasWinter("latitude" in location ? location.latitude : null);
  const name = (id: string | null | undefined) => { const c = selected(id); return c ? tidyCropName(c.name) : "Not chosen"; };
  const cropName = (id: string) => { const c = selected(id); return c ? tidyCropName(c.name) : worldCropName(id); };
  const lookupEntries = (info?.entries ?? []).filter((entry, index, all) => all.findIndex(other => other.crop_id === entry.crop_id) === index);
  const noneFound = lookupEntries.filter(entry => phases[entry.crop_id]?.state === "finished" && entry.missing);
  // The service's gap text for a crop whose lookup found nothing is replaced by the sentence above.
  const shownGaps = gaps.filter(gap => !noneFound.some(entry => [cropName(entry.crop_id), entry.crop_id, entry.crop_id.replaceAll("_", " ")].some(term => gap.toLowerCase().includes(term.toLowerCase()))));
  const aiDates = value.dates.some(date => date.value !== null && (date.origin === "ai_suggested" || date.origin === "source_checked"));
  return <section className="acre-inputs acre-input-card" aria-label={show === "dates" ? "Crop dates" : "Crop plan"}>
    {show === "all" && <h2>What do you grow?</h2>}
    <div className={show === "all" ? "acre-input-plan-grid" : "acre-input-plan-stack"}>
      <div>{crops && <><CropPicker label={winter ? "Previous crop" : "First crop"} regionKey={regionKey} api={api} value={selected(value.plan.previous_crop_id)} onChange={crop => changeCrop("previous", crop)} />{show === "crops" && <p className="acre-input-help">{winter ? "The main crop you harvest before winter." : "The crop you harvest first."}</p>}</>}
        {dates && <>{show === "dates" && <h3>{name(value.plan.previous_crop_id)}</h3>}<DateInput field="prev_harvest" label={show === "dates" ? "Harvest date" : "Previous harvest"} value={value} onChange={onChange} /></>}</div>
      <div>{crops && <><label>{winter ? "Winter use" : "Between the two crops"}<select value={value.plan.winter.kind} onChange={event => onChange({ ...value, plan: { ...value.plan, winter: { kind: event.target.value as PlanDraft["winter"]["kind"], crop_id: null } }, dates: value.dates.filter(d => !d.field.startsWith("winter.")) })}><option value="none">Nothing (bare or stubble)</option><option value="cover">Cover crop</option><option value="winter_grain">{winter ? "Winter grain (harvested)" : "Another crop you harvest"}</option></select></label>
        {show === "crops" && <p className="acre-input-help">What is on the field between the two crops.</p>}
        {value.plan.winter.kind !== "none" && <CropPicker label={winter ? "Winter crop" : "Crop in between"} regionKey={regionKey} api={api} value={selected(value.plan.winter.crop_id)} onChange={crop => changeCrop("winter", crop)} />}</>}
        {dates && value.plan.winter.kind !== "none" && show === "dates" && <h3>{name(value.plan.winter.crop_id)} <small>{winter ? "over winter" : "between the two crops"}</small></h3>}
        {dates && value.plan.winter.kind === "cover" && <><DateInput field="winter.seed" label="Cover seeding" value={value} onChange={onChange} /><DateInput field="winter.terminate" label="Cover end date" value={value} onChange={onChange} /></>}
        {dates && value.plan.winter.kind === "winter_grain" && <><DateInput field="winter.plant" label={winter ? "Winter grain planting" : "In-between crop planting"} value={value} onChange={onChange} /><DateInput field="winter.harvest" label={winter ? "Winter grain harvest" : "In-between crop harvest"} value={value} onChange={onChange} /></>}
      </div>
      <div>{crops && <><CropPicker label="Next crop" regionKey={regionKey} api={api} value={selected(value.plan.next_crop_id)} onChange={crop => changeCrop("next", crop)} />{show === "crops" && <p className="acre-input-help">{winter ? "The main crop you plant after winter." : "The crop you plant after it."}</p>}</>}
        {dates && <>{show === "dates" && <h3>{name(value.plan.next_crop_id)}</h3>}<DateInput field="next_plant" label={show === "dates" ? "Planting date" : "Next planting"} value={value} onChange={onChange} /></>}</div>
    </div>
    {dates && <><button type="button" className={show === "dates" ? undefined : "acre-input-primary"} disabled={loading || !anyCrop} onClick={() => void fill()}>{show === "dates" ? "Refill blank dates with typical ones" : "Fill typical dates"}</button>
    <p className="acre-input-help">{show === "dates" ? "We filled in typical dates for this location. Change any that differ on your farm; your dates stay yours." : "Typical dates come from the service for this location; dates you enter stay yours."}</p>
    {loading && !activeId && <p role="status">Looking up typical dates…</p>}{error && <ErrorNotice error={error} retry={() => void fill()} />}
    {lookupEntries.map(entry => {
      const phase = phases[entry.crop_id];
      const crop = cropName(entry.crop_id);
      const running = phase?.state === "running";
      const waiting = !running && !!activeId && wantsDateLookup(entry);
      const canRepeat = !!info && entry.missing && !running && !waiting && phase?.state !== "failed" && (!!entry.researched_at || startedDateLookups.has(`${entry.crop_id}|${info.regionKey}`));
      return <div key={entry.crop_id}>
        {running && <div role="status" className="acre-input-research-status"><p>Looking up typical planting and harvest dates for {crop}… This usually takes under a minute.</p><button type="button" aria-label={`Stop looking up dates for ${crop}`} onClick={() => stopDateLookup(entry.crop_id)}>Stop</button></div>}
        {waiting && <p role="status" className="acre-input-help">Waiting to look up dates for {crop}.</p>}
        {phase?.state === "failed" && <div className="acre-input-error" role="alert"><p>Typical dates for {crop} could not be looked up right now. Pick the dates you use, or try again later.</p><small>{phase.message}</small><button type="button" aria-label={`Try again to look up dates for ${crop}`} onClick={() => void startDateLookup(entry.crop_id)}>Try again</button></div>}
        {phase?.state === "stopped" && <p className="acre-input-help">The date lookup for {crop} was stopped.</p>}
        {noneFound.includes(entry) && <p className="acre-input-help">No published dates found for {crop} in this area. Enter the dates you use.</p>}
        {canRepeat && <p className="acre-input-help"><button type="button" aria-label={`Look up dates for ${crop} again`} disabled={!!activeId || loading} onClick={() => void startDateLookup(entry.crop_id, true)}>Look up again</button></p>}
      </div>;
    })}
    {!!shownGaps.length && <ul aria-label="Date gaps">{shownGaps.map((gap, i) => <li key={i}>{plainIds(gap)}</li>)}</ul>}
    {aiDates && <p className="acre-input-help">Dates marked AI-found came from a lookup of published guidance for your area. Check them against what you do.</p>}</>}
  </section>;
}
