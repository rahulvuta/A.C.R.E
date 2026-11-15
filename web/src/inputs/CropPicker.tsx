import { useEffect, useId, useRef, useState } from "react";
import { inputsApi, type InputsApi } from "./api";
import { ErrorNotice, OriginLabel, SourceLabel, display, errorText, readable } from "./shared";
import type { Crop, ResearchJob } from "./schema";

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
  return <div className="acre-input-crop-facts">
    <span>Family: {display(crop.family)}</span><span>Use: {crop.roles.length ? crop.roles.map(readable).join(", ") : "Not available"}</span>
    <OriginLabel origin={crop.origin} />
    {(researched || crop.origin === "ai_suggested" || crop.origin === "source_checked") && <span className="acre-input-ai">AI-suggested · review before use</span>}
    <span>Calendar: {calendar === null ? "Not available" : calendar ? "Available" : "Not available"}</span>
    <span>Prices and costs: {economics === null ? "Not available" : economics ? "Available" : "Not available"}</span>
    {crop.region_note && <span>{crop.region_note}</span>}
    {crop.sources?.map((source, i) => <SourceLabel key={i} source={source} />)}
  </div>;
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
export function CropPicker({ regionKey, value, onChange, api = inputsApi, label = "Crop" }: CropPickerProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState<{ loading: boolean; results: Crop[]; canResearch: boolean; error?: string }>({ loading: true, results: [], canResearch: false });
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [researchError, setResearchError] = useState<string>();
  const [researching, setResearching] = useState(false);
  const [result, setResult] = useState<Crop | null>(null);
  const researchController = useRef<AbortController>();
  useEffect(() => {
    researchController.current?.abort();
    setResearching(false); setJob(null); setResult(null); setResearchError(undefined);
    const controller = new AbortController();
    if (value && !query.trim()) {
      setSearch({ loading: false, results: [], canResearch: false });
      return () => { controller.abort(); researchController.current?.abort(); };
    }
    setSearch({ loading: true, results: [], canResearch: false });
    const timer = setTimeout(() => {
      api.search(query.trim(), regionKey, controller.signal).then(data => {
        if (!controller.signal.aborted) setSearch({ loading: false, results: data.results, canResearch: data.can_research });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setSearch({ loading: false, results: [], canResearch: false, error: errorText(error) });
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); researchController.current?.abort(); };
  }, [query, regionKey, attempt, api, value?.crop_id]);
  async function research() {
    researchController.current?.abort();
    const controller = new AbortController(); researchController.current = controller;
    setResearching(true); setResearchError(undefined); setResult(null); setJob(null);
    try {
      let current = await api.research(query.trim(), regionKey, controller.signal);
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
  return <section className="acre-inputs acre-input-picker" aria-label={label}>
    <label htmlFor={id}>{label}</label>
    {value && <div className="acre-input-selected"><strong>{value.name}</strong><CropFacts crop={value} /><button type="button" onClick={() => onChange(null)}>Clear {label.toLowerCase()}</button></div>}
    <input id={id} type="search" value={query} placeholder="Search by crop name" onChange={event => setQuery(event.target.value)} aria-describedby={`${id}-help`} />
    <p id={`${id}-help`} className="acre-input-help">Choose a crop to see whether local dates and money references are available.</p>
    {search.loading && <p role="status">Searching crops…</p>}
    {search.error && <ErrorNotice error={search.error} retry={() => setAttempt(n => n + 1)} />}
    {!!search.results.length && <ul className="acre-input-crop-list" aria-label={`${label} results`}>{search.results.map(crop => <li key={crop.crop_id}>
      <button type="button" aria-pressed={value?.crop_id === crop.crop_id} onClick={() => { onChange(crop); setQuery(""); }}>{crop.name}{value?.crop_id === crop.crop_id ? " · Selected" : ""}</button><CropFacts crop={crop} />
    </li>)}</ul>}
    {!search.loading && !search.error && search.results.length === 0 && (!value || query.trim()) && <p>No crops found{query.trim() ? ` for “${query.trim()}”` : ""}.</p>}
    {!search.loading && !search.error && search.results.length === 0 && !!query.trim() && search.canResearch && !result && <div>
      <button type="button" className="acre-input-primary" disabled={researching || !regionKey} onClick={() => void research()}>Research '{query.trim()}' with AI</button>
      <p className="acre-input-help">AI receives only the crop name and region. Check its sources before choosing it.</p>
      {!regionKey && <p>Select a region before starting research.</p>}
    </div>}
    {researching && <div role="status"><p>{job?.progress || "Research in progress: looking for crop references…"}</p><button type="button" onClick={() => { researchController.current?.abort(); setResearching(false); setJob(null); }}>Stop checking</button></div>}
    {researchError && <ErrorNotice error={researchError} />}
    {result && <div className="acre-input-researched"><strong>{result.name}</strong><CropFacts crop={result} researched />{!result.sources?.length && <p>Sources: Not available</p>}<button type="button" onClick={() => { onChange(result); setQuery(""); }}>Use {result.name}</button></div>}
  </section>;
}
