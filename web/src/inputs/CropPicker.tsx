import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { tidyCropName } from "../ui/cropNames";
import { inputsApi, type InputsApi } from "./api";
import { ErrorNotice, OriginLabel, SourceLabel, errorText } from "./shared";
import type { Crop, ResearchJob } from "./schema";

/*
  Crop picker: a search box with a dropdown of crops already in the shared library. Typing
  filters the list; a crop that is not there can be looked up ("researched") and is then saved
  to the library. Details are shown only for the crop that was picked.
*/
export interface CropPickerProps {
  regionKey: string;
  value: Crop | null;
  onChange: (value: Crop | null) => void;
  api?: InputsApi;
  label?: string;
}
function CropFacts({ crop, researched = false }: { crop: Crop; researched?: boolean }) {
  const calendar = crop.has_calendar ?? (crop.calendars ? crop.calendars.length > 0 : null);
  const economics = crop.has_economics ?? (crop.economics_refs ? crop.economics_refs.length > 0 : null);
  const ai = researched || crop.origin === "ai_suggested" || crop.origin === "source_checked";
  // What a grower needs first: where the entry came from and whether dates and prices exist here.
  // The plant family and the source pages are kept, one click away.
  return <div className="acre-input-crop-facts">
    <OriginLabel origin={crop.origin} />
    {ai && <span className="acre-input-ai">AI-suggested · review before use</span>}
    {calendar !== null ? <span data-found={calendar ? "yes" : "no"}>{calendar ? "Typical dates for your area: found" : "No typical dates here: you enter your own"}</span> : null}
    {economics !== null ? <span data-found={economics ? "yes" : "no"}>{economics ? "Local prices: found" : "Local prices: looked up at the prices step"}</span> : null}
    {crop.family || crop.sources?.length ? <details className="acre-input-crop-more"><summary>More about this crop</summary>
      {crop.family ? <span>Family: {crop.family}</span> : null}
      {crop.sources?.map((source, i) => <SourceLabel key={i} source={source} />)}
    </details> : null}
  </div>;
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
const norm = (s: string) => s.trim().toLowerCase().replaceAll("_", " ");

export function CropPicker({ regionKey, value, onChange, api = inputsApi, label = "Crop" }: CropPickerProps) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState<{ loading: boolean; results: Crop[]; canResearch: boolean; error?: string }>({ loading: false, results: [], canResearch: false });
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [researchError, setResearchError] = useState<string>();
  const [researching, setResearching] = useState(false);
  const [researchName, setResearchName] = useState("");
  const [result, setResult] = useState<Crop | null>(null);
  const researchController = useRef<AbortController>();
  const input = useRef<HTMLInputElement>(null);
  const editing = !value || changing;

  useEffect(() => () => researchController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    if (!editing) return () => controller.abort();
    setSearch(s => ({ ...s, loading: true, error: undefined }));
    const timer = setTimeout(() => {
      api.search(query.trim(), regionKey, controller.signal).then(data => {
        if (!controller.signal.aborted) { setSearch({ loading: false, results: data.results, canResearch: data.can_research }); setActive(0); }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setSearch({ loading: false, results: [], canResearch: false, error: errorText(error) });
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, regionKey, attempt, api, editing]);

  const typed = query.trim();
  const exact = search.results.some(c => norm(c.name) === norm(typed) || norm(c.crop_id) === norm(typed));
  const offerResearch = !!typed && !exact && search.canResearch && !search.loading && !search.error;
  const options = search.results.slice(0, 12);
  const count = options.length + (offerResearch ? 1 : 0);

  function pick(crop: Crop) { onChange(crop); setQuery(""); setOpen(false); setChanging(false); setResult(null); }
  async function research() {
    if (!regionKey) return;
    setOpen(false);
    researchController.current?.abort();
    const controller = new AbortController(); researchController.current = controller;
    const name = typed;
    setResearchName(name); setResearching(true); setResearchError(undefined); setResult(null); setJob(null);
    try {
      let current = await api.research(name, regionKey, controller.signal);
      for (let poll = 0; !controller.signal.aborted; poll++) {
        setJob(current);
        if (current.job_status === "failed") throw new Error(current.reason_text || "Research did not finish. You can try again.");
        if (current.job_status === "ready") {
          const crop = current.crop ?? (current.crop_id ? await api.crop(current.crop_id, regionKey, controller.signal) : null);
          if (!crop) throw new Error("Research finished without a crop. Please try again.");
          if (!["ai_suggested", "source_checked"].includes(crop.origin)) throw new Error("The research result is missing its AI provenance. Please check the service version.");
          if (!controller.signal.aborted) setResult(crop);
          break;
        }
        if (poll >= 80) throw new Error("Research is taking longer than expected. Try again to check the crop library.");
        await pause(controller.signal);
        current = await api.researchJob(current.job_id, controller.signal);
      }
    } catch (error) { if (!controller.signal.aborted) setResearchError(errorText(error)); }
    finally { if (!controller.signal.aborted) setResearching(false); }
  }
  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, Math.max(count - 1, 0))); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (event.key === "Enter" && open && count) {
      event.preventDefault();
      if (active < options.length) pick(options[active]!); else void research();
    } else if (event.key === "Escape") { setOpen(false); if (value) { setChanging(false); setQuery(""); } }
  }

  return <section className="acre-inputs acre-input-picker" aria-label={label}>
    <label htmlFor={id}>{label}</label>
    {!editing && value ? <div className="acre-input-selected">
      <div className="acre-input-selected-head"><strong>{tidyCropName(value.name)}</strong>
        <button type="button" className="acre-input-change" onClick={() => { setChanging(true); setOpen(true); setTimeout(() => input.current?.focus(), 0); }}>Change {label.toLowerCase()}</button></div>
      <CropFacts crop={value} />
    </div> : <div className="acre-input-combo">
      <input ref={input} id={id} type="text" role="combobox" autoComplete="off" value={query}
        placeholder={value ? `Replace ${tidyCropName(value.name)}: type or pick a crop` : "Click to pick a crop, or type to search"}
        aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && count ? `${id}-opt-${active}` : undefined}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={event => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={onKey} />
      {open && <ul id={listId} role="listbox" className="acre-input-combo-list" aria-label={`${label} choices`}>
        {search.loading && !options.length && <li className="acre-input-combo-note" role="presentation">Searching crops…</li>}
        {options.map((crop, i) => <li key={crop.crop_id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(crop)}>
          <span className="acre-input-combo-name">{tidyCropName(crop.name)}</span>
          <span className="acre-input-combo-tags">
            {crop.has_calendar ? <span>local dates</span> : null}
            {crop.has_economics ? <span>local prices</span> : null}
            {crop.origin === "ai_suggested" || crop.origin === "source_checked" ? <span>AI-researched</span> : null}
          </span>
        </li>)}
        {!search.loading && !search.error && !options.length && !offerResearch && <li className="acre-input-combo-note" role="presentation">{typed ? `No crops match “${typed}”.` : "No crops in the library for this area yet. Type a crop name."}</li>}
        {offerResearch && <li id={`${id}-opt-${options.length}`} role="option" aria-selected={active === options.length} aria-disabled={!regionKey}
          className="acre-input-combo-research" onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(options.length)}
          onClick={() => void research()}>
          <span className="acre-input-combo-name">Not listed? Look up “{typed}”</span>
          <span className="acre-input-combo-hint">{regionKey ? "AI checks published sources (about a minute) and adds it to the library" : "Choose a field with a known region first"}</span>
        </li>}
      </ul>}
    </div>}
    {editing && value && changing && <button type="button" className="acre-input-change" onClick={() => { setChanging(false); setOpen(false); setQuery(""); }}>Keep {tidyCropName(value.name)}</button>}
    {search.error && editing && <ErrorNotice error={search.error} retry={() => setAttempt(n => n + 1)} />}
    {researching && <div role="status" className="acre-input-research-status"><p>{job?.progress || `Looking up “${researchName}”: checking published references…`}</p><button type="button" onClick={() => { researchController.current?.abort(); setResearching(false); setJob(null); }}>Stop</button></div>}
    {researchError && <ErrorNotice error={researchError} />}
    {result && <div className="acre-input-researched"><strong>{tidyCropName(result.name)}</strong><CropFacts crop={result} researched />{!result.sources?.length && <p>No source was found for this crop.</p>}
      <p className="acre-input-help">AI received only the crop name and region. Check its sources before using it.</p>
      <button type="button" className="acre-input-primary" onClick={() => pick(result)}>Use {tidyCropName(result.name)}</button></div>}
  </section>;
}
