import { useCallback, useEffect, useRef, useState } from "react";
import { inputsApi, type InputsApi } from "./api";
import type { CropEconomics, CropOverrides, EconomicsSuggestion, EconomicsValue, InputArea, InputLocation, PriceCase, Quantity } from "./schema";
import { ErrorNotice, OriginLabel, SourceLabel, display, errorText, pauseFor, readable, useInputRequest } from "./shared";

export interface EconomicsEditorProps {
  location: InputLocation; crops: string[]; area: InputArea; value: EconomicsValue;
  onChange: (value: EconomicsValue) => void; api?: InputsApi;
  /** The whole editor, only the prices, yields and costs, or only the weather-loss estimates. */
  show?: "all" | "prices" | "losses";
}
/* Crop + region pairs a lookup was started for in this page session; remounting the editor must not start them again. */
const startedLookups = new Set<string>();
export function resetEconomicsLookupsForTests() { startedLookups.clear(); }
const POLL_MS = 2000;
const MAX_POLLS = 90;
type LookupField = "price" | "yield" | "costs";
const FIELD_WORD: Record<LookupField, string> = { price: "prices", yield: "yields", costs: "costs" };
/** Which of price (typical), yield and costs the estimate has no number for. */
function missingFields(crop: CropEconomics): LookupField[] {
  const missing: LookupField[] = [];
  if (crop.price?.typical == null) missing.push("price");
  if (crop.yield?.value == null) missing.push("yield");
  if (!crop.costs.items.some(item => item.value != null) && crop.costs.total_per_area?.value == null) missing.push("costs");
  return missing;
}
function farmerHas(overrides: CropOverrides, field: LookupField) {
  if (field === "price") return overrides.price?.typical?.value != null;
  if (field === "yield") return overrides.yield?.value != null;
  return Object.values(overrides.costs ?? {}).some(cost => cost.value != null);
}
const joinWords = (words: string[]) => words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
function isChecked(crop: CropEconomics) {
  return crop.price?.origin === "source_checked" || crop.yield?.origin === "source_checked" || crop.costs.items.some(item => item.origin === "source_checked") || crop.costs.total_per_area?.origin === "source_checked";
}
type LookupPhase = { state: "running" } | { state: "finished" } | { state: "stopped" } | { state: "failed"; message: string };
function suggestionLabel(suggestion: EconomicsSuggestion) {
  return suggestion.field === "price" ? "Price" : suggestion.field === "yield" ? "Yield" : `Cost · ${readable(suggestion.item || "total")}`;
}
function adopted(suggestion: EconomicsSuggestion, overrides: CropOverrides) {
  const same = (quantity?: Quantity) => quantity?.origin === "grower" && quantity.value === suggestion.value && quantity.unit === suggestion.unit;
  if (suggestion.field === "price") return same(overrides.price?.typical) && same(overrides.price?.low) && same(overrides.price?.high);
  if (suggestion.field === "yield") return same(overrides.yield);
  return same(overrides.costs?.[suggestion.item || "total"]);
}
export const createEconomicsValue = (): EconomicsValue => ({ overrides: {}, loss_assumptions: { dry_spring_pct: null, heavy_rain_pct: null } });
function ValueRow({ label, explanation, reference, override, onChange, onReset }: { label: string; explanation: string; reference?: Quantity | null; override?: Quantity; onChange: (value: Quantity) => void; onReset: () => void }) {
  const effective = override ?? reference;
  return <tr>
    <th scope="row">{label}<small>{explanation}</small></th>
    <td><label className="acre-input-sr-only">{label} value</label><input aria-label={`${label} value`} type="number" step="any" min="0" placeholder="Not available" value={effective?.value ?? ""} onChange={event => {
      const number = event.target.value === "" ? null : Number(event.target.value);
      if (number === null || Number.isFinite(number) && number >= 0) onChange({ value: number, unit: effective?.unit ?? "", origin: "grower" });
    }} /><input aria-label={`${label} unit`} placeholder="Unit not available" value={effective?.unit ?? ""} onChange={event => onChange({ value: effective?.value ?? null, unit: event.target.value, origin: "grower" })} /><OriginLabel origin={effective?.origin} /></td>
    <td><span>{display(reference?.value)}{reference?.value != null && reference.unit ? ` ${reference.unit}` : ""}</span><OriginLabel origin={reference?.origin} /><SourceLabel source={reference?.source} /></td>
    <td><button type="button" disabled={override === undefined} onClick={onReset} aria-label={`Reset ${label}`}>Reset</button></td>
  </tr>;
}
export function EconomicsEditor({ location, crops, area, value, onChange, api = inputsApi, show = "all" }: EconomicsEditorProps) {
  const prices = show !== "losses";
  const losses = show !== "prices";
  const uniqueCrops = [...new Set(crops)];
  const key = JSON.stringify({ location, crops: uniqueCrops, area });
  const loader = useCallback((signal: AbortSignal) => api.estimate({ location, crops: uniqueCrops, area, equipment: [], overrides: {} }, signal), [api, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const request = useInputRequest(key, loader, prices && uniqueCrops.length > 0);
  const [costNames, setCostNames] = useState<Record<string, string>>({});
  const [phases, setPhases] = useState<Record<string, LookupPhase>>({});
  const lookupController = useRef<AbortController>();
  const runningKey = useRef<string | null>(null);
  const regionKey = request.data?.research?.available === true ? request.data.research.region_key || "" : "";
  const findDefaults = (cropId: string) => request.data?.crops.find(crop => crop.crop_id === cropId || crop.aliases.includes(cropId));
  const lookupKey = (cropId: string) => `${cropId}|${regionKey}`;
  function wantsLookup(cropId: string) {
    const defaults = findDefaults(cropId);
    if (!regionKey || !defaults || defaults.economics_research?.researched_at || startedLookups.has(lookupKey(cropId))) return false;
    const overrides = value.overrides[cropId] ?? {};
    return missingFields(defaults).some(field => !farmerHas(overrides, field));
  }
  const activeId = Object.keys(phases).find(id => phases[id]!.state === "running" || (phases[id]!.state === "finished" && request.refreshing));
  async function startLookup(cropId: string, refresh = false) {
    if (!regionKey) return;
    lookupController.current?.abort();
    const controller = new AbortController(); lookupController.current = controller;
    const { signal } = controller;
    const started = lookupKey(cropId);
    startedLookups.add(started); runningKey.current = started;
    setPhases(previous => ({ ...previous, [cropId]: { state: "running" } }));
    try {
      let job = await (refresh ? api.economicsResearch(cropId, regionKey, signal, true) : api.economicsResearch(cropId, regionKey, signal));
      for (let poll = 0; job.job_status === "pending"; poll++) {
        if (poll >= MAX_POLLS) throw new Error("The lookup is taking longer than expected. You can try again.");
        await pauseFor(signal, POLL_MS);
        job = await api.economicsResearchJob(job.job_id, signal);
      }
      if (signal.aborted) return;
      runningKey.current = null;
      if (job.job_status === "failed") { setPhases(previous => ({ ...previous, [cropId]: { state: "failed", message: job.reason_text || "The lookup did not finish." } })); return; }
      setPhases(previous => ({ ...previous, [cropId]: { state: "finished" } }));
      request.refresh();
    } catch (error) {
      if (signal.aborted) return;
      runningKey.current = null;
      setPhases(previous => ({ ...previous, [cropId]: { state: "failed", message: errorText(error) } }));
    }
  }
  function stopLookup(cropId: string) {
    lookupController.current?.abort(); lookupController.current = undefined; runningKey.current = null;
    setPhases(previous => ({ ...previous, [cropId]: { state: "stopped" } }));
  }
  // New place or crops: forget progress and stop; a lookup cut short this way may start again.
  useEffect(() => {
    setPhases(previous => Object.keys(previous).length ? {} : previous);
    return () => {
      lookupController.current?.abort(); lookupController.current = undefined;
      if (runningKey.current) { startedLookups.delete(runningKey.current); runningKey.current = null; }
    };
  }, [key]);
  // One crop at a time, in the editor's order.
  useEffect(() => {
    if (!prices || !request.data || request.refreshing || activeId) return;
    const next = uniqueCrops.find(wantsLookup);
    if (next) void startLookup(next);
    // wantsLookup and startLookup close over the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices, request.data, request.refreshing, activeId, value.overrides, key]);
  function update(cropId: string, overrides: CropOverrides) {
    const previous = value.overrides[cropId]?.costs;
    const changed = Object.keys(overrides.costs ?? {}).filter(item => overrides.costs?.[item] !== previous?.[item]);
    if (changed.includes("total")) overrides = { ...overrides, costs: { total: overrides.costs!.total! } };
    else if (previous?.total && changed.length) {
      const { total: _total, ...items } = overrides.costs ?? {};
      overrides = { ...overrides, costs: items };
    }
    onChange({ ...value, overrides: { ...value.overrides, [cropId]: overrides } });
  }
  function adopt(cropId: string, suggestion: EconomicsSuggestion, overrides: CropOverrides) {
    const quantity: Quantity = { value: suggestion.value, unit: suggestion.unit, origin: "grower" };
    if (suggestion.field === "price") update(cropId, { ...overrides, price: { low: quantity, typical: quantity, high: quantity } });
    else if (suggestion.field === "yield") update(cropId, { ...overrides, yield: quantity });
    else update(cropId, { ...overrides, costs: { ...overrides.costs, [suggestion.item || "total"]: quantity } });
  }
  return <section className="acre-inputs acre-input-card" aria-label={prices ? "Prices, yields and costs" : "Weather losses"}>{prices && <><h2>Your prices, yields and costs</h2>
    <p>We filled these in from published sources for your area, so you don't have to look them up. Change any number that is different on your farm; your numbers are labelled "You entered". Blanks mean no published source was found: enter yours if you know it, or leave it blank and the simulation runs without money results for that crop. Where nothing is published in our tables, the app looks up official sources for your crop and area and fills in what it can check.</p>
    {request.loading && <p role="status">Looking up regional references…</p>}
    {request.error && <ErrorNotice error={request.error} retry={request.retry} />}
    {!uniqueCrops.length && <p>Choose crops to enter their prices, yields and costs.</p>}
    {uniqueCrops.map(cropId => {
      const defaults = request.data?.crops.find(crop => crop.crop_id === cropId || crop.aliases.includes(cropId));
      const overrides = value.overrides[cropId] ?? {};
      const costItems = overrides.costs?.total ? ["total"] : [...new Set([...(defaults?.costs.items.map(item => item.item) ?? []), ...Object.keys(overrides.costs ?? {})])];
      const phase = phases[cropId];
      const running = phase?.state === "running" || (phase?.state === "finished" && request.refreshing);
      const waiting = !running && !!activeId && wantsLookup(cropId);
      const missing = defaults ? missingFields(defaults) : [];
      const suggestions = defaults?.suggestions ?? [];
      const nothingFound = phase?.state === "finished" && !request.refreshing && !!defaults && missing.length > 0 && !suggestions.length;
      const canRepeat = !!regionKey && !!defaults && !running && !waiting && phase?.state !== "failed" && missing.length > 0 && (!!defaults.economics_research?.researched_at || startedLookups.has(lookupKey(cropId)));
      const name = readable(cropId);
      return <section key={cropId} className="acre-input-economics-crop" aria-label={`${readable(cropId)} economics`}><h3>{readable(cropId)}</h3>
        {defaults && isChecked(defaults) && <p className="acre-input-help">Found by AI research and checked against the cited page. Change any number that is different on your farm.</p>}
        {running && <div role="status" className="acre-input-research-status"><p>Looking up published prices, yields and costs for {name}… This usually takes under a minute. You can keep going; values fill in when it finishes.</p><button type="button" aria-label={`Stop looking up ${name}`} onClick={() => stopLookup(cropId)}>Stop</button></div>}
        {waiting && <p role="status" className="acre-input-help">Waiting to look up {name}.</p>}
        {phase?.state === "failed" && <div className="acre-input-error" role="alert"><p>{phase.message}</p><button type="button" aria-label={`Try again to look up ${name}`} onClick={() => void startLookup(cropId)}>Try again</button></div>}
        {phase?.state === "stopped" && <p className="acre-input-help">The lookup for {name} was stopped.</p>}
        {nothingFound && <p className="acre-input-help">No published {joinWords(missing.map(field => FIELD_WORD[field]))} found for {name} in this area. Enter yours if you know them, or leave them blank: the simulation then runs without money results for this crop.</p>}
        {canRepeat && <p className="acre-input-help"><button type="button" aria-label={`Look up ${name} again`} disabled={!!activeId} onClick={() => void startLookup(cropId, true)}>Look up again</button></p>}
        {defaults?.reason_text && <p>{defaults.reason_text}</p>}
        {defaults?.status && defaults.status !== "complete" && !running && !waiting && !nothingFound && <p className="acre-input-help">{defaults.status === "partial" ? "Some values have no published source for this area. Fill in the blanks if you know them." : "No published prices or costs for this crop in this area. Enter yours if you know them."}</p>}
        <div className="acre-input-table-wrap"><table><caption className="acre-input-sr-only">{readable(cropId)} price cases, yield and costs</caption><thead><tr><th scope="col">Input</th><th scope="col">Value and unit to use</th><th scope="col">Regional default and source</th><th scope="col">Restore default</th></tr></thead><tbody>
          {(["low", "typical", "high"] as PriceCase[]).map(priceCase => <ValueRow key={priceCase} label={`Price · ${priceCase}`} explanation={priceCase === "typical" ? "The middle price case for one unit of harvested crop." : `The ${priceCase === "low" ? "lower" : "upper"} price case for one unit of harvested crop.`} reference={defaults?.price ? { ...defaults.price, value: defaults.price[priceCase] } : undefined} override={overrides.price?.[priceCase]} onChange={quantity => update(cropId, { ...overrides, price: { ...overrides.price, [priceCase]: quantity } })} onReset={() => { const price = { ...overrides.price }; delete price[priceCase]; update(cropId, { ...overrides, price }); }} />)}
          <ValueRow label="Yield" explanation="The harvested amount per acre or hectare, in the unit shown." reference={defaults?.yield} override={overrides.yield} onChange={quantity => update(cropId, { ...overrides, yield: quantity })} onReset={() => { const next = { ...overrides }; delete next.yield; update(cropId, next); }} />
          {costItems.map(item => <ValueRow key={item} label={`Cost · ${readable(item)}`} explanation="The cost of this item per acre or hectare, in the unit shown." reference={defaults?.costs.items.find(cost => cost.item === item)} override={overrides.costs?.[item]} onChange={quantity => update(cropId, { ...overrides, costs: { ...overrides.costs, [item]: quantity } })} onReset={() => { const costs = { ...overrides.costs }; delete costs[item]; update(cropId, { ...overrides, costs }); }} />)}
        </tbody></table></div>
        {suggestions.length > 0 && <div className="acre-input-suggestions"><h4>Found by AI, not verified</h4>
          <p className="acre-input-help">These were found by AI research but could not be checked against the cited page. Open the source before using one.</p>
          <ul aria-label={`${name} suggestions found by AI`}>{suggestions.map((suggestion, index) => {
            const used = adopted(suggestion, overrides);
            const quote = suggestion.source?.evidence_quote;
            return <li key={index}><div className="acre-input-suggestion-main"><strong>{suggestionLabel(suggestion)}</strong> <span>{suggestion.value} {suggestion.unit}{suggestion.year != null ? `, ${suggestion.year}` : ""}</span> <OriginLabel origin={suggestion.origin} /></div>
              <SourceLabel source={suggestion.source} />
              {quote && <blockquote><q>{quote}</q></blockquote>}
              {suggestion.note && <small>{suggestion.note}</small>}
              <button type="button" disabled={used} aria-label={`${used ? "Using this value" : "Use this value"} for ${name} ${suggestionLabel(suggestion)}`} onClick={() => adopt(cropId, suggestion, overrides)}>{used ? "Using this value" : "Use this value"}</button></li>;
          })}</ul></div>}
        {!costItems.length && <p>Cost items: Not available. Add a cost you know.</p>}
        <div className="acre-input-inline"><label>Another cost item<input placeholder="For example, seed or fuel" value={costNames[cropId] ?? ""} onChange={event => setCostNames({ ...costNames, [cropId]: event.target.value })} /></label><button type="button" disabled={!costNames[cropId]?.trim() || costItems.includes(costNames[cropId]?.trim() ?? "")} onClick={() => { const name = costNames[cropId]?.trim(); if (name) { update(cropId, { ...overrides, costs: { ...overrides.costs, [name]: { value: null, unit: "", origin: "grower" } } }); setCostNames({ ...costNames, [cropId]: "" }); } }}>Add cost item</button></div>
      </section>;
    })}
    {!!request.data?.gaps.length && <ul aria-label="Economics gaps">{request.data.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>}</>}
    {losses && <fieldset className="acre-input-loss"><legend>Your estimate of weather losses</legend><p>These percentages are your estimates of lost yield; they are not measured or modeled losses. Leave them blank if unknown.</p>
      {(["dry_spring_pct", "heavy_rain_pct"] as const).map(kind => <div key={kind}><label>{kind === "dry_spring_pct" ? "In a dry spring I lose about" : "In a heavy-rain year I lose about"}<input aria-label={kind === "dry_spring_pct" ? "Dry spring yield loss percent" : "Heavy rain yield loss percent"} type="number" min="0" max="100" step="any" placeholder="Not available" value={value.loss_assumptions[kind] ?? ""} onChange={event => {
        const number = event.target.value === "" ? null : Number(event.target.value);
        if (number === null || Number.isFinite(number) && number >= 0 && number <= 100) onChange({ ...value, loss_assumptions: { ...value.loss_assumptions, [kind]: number } });
      }} />% of yield</label><span>Your estimate <OriginLabel origin="assumed" /></span></div>)}
      <p className="acre-input-help">Without an estimate, weather risk and money results stay separate.</p>
    </fieldset>}
  </section>;
}
