import { ConfidenceBadge } from "../ui/ConfidenceBadge";
import { hasWinter, worldCropName } from "../ui/cropNames";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { inputsApi, type InputsApi } from "./api";
import type { CropEconomics, CropOverrides, EconomicsSuggestion, EconomicsValue, InputArea, InputLocation, PriceCase, Quantity } from "./schema";
import { ErrorNotice, OriginLabel, SourceLabel, errorText, pauseFor, readable, useInputRequest } from "./shared";

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
const LOSS_CHOICES = [{ label: "A little", pct: 10 }, { label: "About a quarter", pct: 25 }, { label: "About half", pct: 50 }, { label: "Most of it", pct: 75 }];
export const createEconomicsValue = (): EconomicsValue => ({ overrides: {}, loss_assumptions: { dry_spring_pct: null, heavy_rain_pct: null } });
/** A number as a grower would write it: two decimals when small, none when large. */
const round = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(Math.abs(v) < 10 ? 2 : Math.abs(v) < 1000 ? 1 : 0)));
const currencyOf = (unit: string | null | undefined) => /^([A-Za-z]{3})\//.exec(unit ?? "")?.[1]?.toUpperCase() ?? "USD";
const PRICE_UNITS = (cur: string) => [`${cur}/t`, `${cur}/kg`, `${cur}/bu`, `${cur}/cwt`, `${cur}/lb`];
const YIELD_UNITS = ["t/ha", "kg/ha", "bu/acre", "lb/acre", "t/acre"];
const COST_UNITS = (cur: string) => [`${cur}/ha`, `${cur}/acre`];
const COST_STARTERS = ["seed", "fertilizer", "labour", "hired machines", "land rent"];
function ValueRow({ label, title, explanation, reference, override, onChange, onReset, units }: { label: string; title?: string; explanation: string; reference?: Quantity | null; override?: Quantity; onChange: (value: Quantity) => void; onReset: () => void; units: string[] }) {
  const effective = override ?? reference;
  const listId = useId();
  return <tr>
    <th scope="row">{title ?? label}<small>{explanation}</small></th>
    <td><label className="acre-input-sr-only">{label} value</label><input aria-label={`${label} value`} type="number" step="any" min="0" placeholder="Enter yours" value={(override ? override.value : round(reference?.value)) ?? ""} onChange={event => {
      const number = event.target.value === "" ? null : Number(event.target.value);
      if (number === null || Number.isFinite(number) && number >= 0) onChange({ value: number, unit: effective?.unit ?? "", origin: "grower" });
    }} /><input aria-label={`${label} unit`} list={listId} placeholder="Pick a unit" aria-invalid={override?.value != null && !override.unit.trim() ? true : undefined} value={effective?.unit ?? ""} onChange={event => onChange({ value: effective?.value ?? null, unit: event.target.value, origin: "grower" })} /><datalist id={listId}>{units.map(unit => <option key={unit} value={unit} />)}</datalist>{effective?.origin ? <OriginLabel origin={effective.origin} /> : null}</td>
    <td>{reference?.value != null ? <><span>{round(reference.value)}{reference.unit ? ` ${reference.unit}` : ""}</span><OriginLabel origin={reference.origin} /><SourceLabel source={reference.source} /></> : <span className="acre-input-muted">None found for this area</span>}</td>
    <td><button type="button" disabled={override === undefined} onClick={onReset} aria-label={`Reset ${label}`}>Reset</button></td>
  </tr>;
}
export function EconomicsEditor({ location, crops, area, value, onChange, api = inputsApi, show = "all" }: EconomicsEditorProps) {
  const prices = show !== "losses";
  const winter = hasWinter("latitude" in location ? location.latitude : null);
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
    <p>Where a published number exists for your area it is filled in with its source. Where none was found the box is empty. Change any number that is different on your farm.</p>
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
      const hasPrice = (overrides.price?.typical?.value ?? defaults?.price?.typical) != null;
      const hasYield = (overrides.yield?.value ?? defaults?.yield?.value) != null;
      const usesOwn = !!overrides.price?.typical || !!overrides.yield;
      const cur = currencyOf(overrides.price?.typical?.unit ?? defaults?.price?.unit);
      const areaUnit = area.unit === "acre" ? "acre" : "ha";
      // One price is asked. The bad-year and good-year prices follow it until the grower sets them apart.
      const follows = (c: "low" | "high") => { const o = overrides.price?.[c], t = overrides.price?.typical; return !o || (!!t && o.value === t.value && o.unit === t.unit); };
      const setPrice = (quantity: Quantity) => update(cropId, { ...overrides, price: { ...overrides.price, typical: quantity, ...(follows("low") ? { low: quantity } : {}), ...(follows("high") ? { high: quantity } : {}) } });
      const resetPrice = () => { const price = { ...overrides.price }; const t = price.typical; delete price.typical; for (const c of ["low", "high"] as const) if (t && price[c]?.value === t.value && price[c]?.unit === t.unit) delete price[c]; const next = { ...overrides }; if (Object.keys(price).length) next.price = price; else delete next.price; update(cropId, next); };
      const priceRef = (c: PriceCase) => (defaults?.price ? { ...defaults.price, value: defaults.price[c] } : undefined);
      const resetCase = (c: PriceCase) => { const price = { ...overrides.price }; delete price[c]; const next = { ...overrides }; if (Object.keys(price).length) next.price = price; else delete next.price; update(cropId, next); };
      return <section key={cropId} className="acre-input-economics-crop" aria-label={`${readable(cropId)} economics`}><h3>{worldCropName(cropId).replace(/^./, c => c.toUpperCase())}</h3>
        {defaults || Object.keys(overrides).length ? <p className="acre-input-money-line" data-ready={hasPrice && hasYield ? "yes" : "no"}>{hasPrice && hasYield ? (usesOwn ? "Money results for this crop use your numbers." : "Money results for this crop use published numbers for your area.") : "No money results for this crop yet: it needs a price and a yield."}</p> : null}
        {defaults && isChecked(defaults) && <p className="acre-input-help">Found by AI research and checked against the cited page. Change any number that is different on your farm.</p>}
        {running && <div role="status" className="acre-input-research-status"><p>Looking up published prices, yields and costs for {name}… This usually takes under a minute. You can keep going; values fill in when it finishes.</p><button type="button" aria-label={`Stop looking up ${name}`} onClick={() => stopLookup(cropId)}>Stop</button></div>}
        {waiting && <p role="status" className="acre-input-help">Waiting to look up {name}.</p>}
        {phase?.state === "failed" && <div className="acre-input-error" role="alert"><p>Published numbers for {name} could not be looked up right now. Enter your own, or try again later.</p><small>{phase.message}</small><button type="button" aria-label={`Try again to look up ${name}`} onClick={() => void startLookup(cropId)}>Try again</button></div>}
        {phase?.state === "stopped" && <p className="acre-input-help">The lookup for {name} was stopped.</p>}
        {nothingFound && <p className="acre-input-help">No published {joinWords(missing.map(field => FIELD_WORD[field]))} found for {name} in this area. Enter yours if you know them, or leave them blank: the simulation then runs without money results for this crop.</p>}
        {canRepeat && <p className="acre-input-help"><button type="button" aria-label={`Look up ${name} again`} disabled={!!activeId} onClick={() => void startLookup(cropId, true)}>Look up again</button></p>}
        {defaults?.reason_text && <p>{defaults.reason_text}</p>}
        {defaults?.status && defaults.status !== "complete" && !running && !waiting && !nothingFound && <p className="acre-input-help">{defaults.status === "partial" ? "Some values have no published source for this area. Fill in the blanks if you know them." : "No published prices or costs for this crop in this area. Enter yours if you know them."}</p>}
        <div className="acre-input-table-wrap"><table><caption className="acre-input-sr-only">{readable(cropId)} price cases, yield and costs</caption><thead><tr><th scope="col">Input</th><th scope="col">Your number and unit</th><th scope="col">Published for your area</th><th scope="col">Undo</th></tr></thead><tbody>
          <ValueRow label="Price · typical" title="Price" explanation="What you usually get for one unit of the harvested crop." units={PRICE_UNITS(cur)} reference={priceRef("typical")} override={overrides.price?.typical} onChange={setPrice} onReset={resetPrice} />
          <ValueRow label="Yield" explanation="What you usually harvest from one hectare or acre." units={YIELD_UNITS} reference={defaults?.yield} override={overrides.yield} onChange={quantity => update(cropId, { ...overrides, yield: quantity })} onReset={() => { const next = { ...overrides }; delete next.yield; update(cropId, next); }} />
          {costItems.map(item => <ValueRow key={item} label={`Cost · ${readable(item)}`} explanation="What this costs for one hectare or acre." units={COST_UNITS(cur)} reference={defaults?.costs.items.find(cost => cost.item === item)} override={overrides.costs?.[item]} onChange={quantity => update(cropId, { ...overrides, costs: { ...overrides.costs, [item]: quantity } })} onReset={() => { const costs = { ...overrides.costs }; delete costs[item]; update(cropId, { ...overrides, costs }); }} />)}
        </tbody></table></div>
        <p className="acre-input-help">A unit is a currency code and an amount: USD/t, INR/t, KES/kg, EUR/t. Use the same amount for price and yield (a price per tonne with a yield in tonnes).</p>
        <div className="acre-input-cost-starters" role="group" aria-label={`Add a cost for ${name}`}><span>Add a cost:</span>{COST_STARTERS.filter(item => !costItems.includes(item)).map(item => <button key={item} type="button" onClick={() => update(cropId, { ...overrides, costs: { ...overrides.costs, [item]: { value: null, unit: `${cur}/${areaUnit}`, origin: "grower" } } })}>{item}</button>)}</div>
        <details className="acre-input-more-prices"><summary>Prices in a bad and a good year</summary>
          <p className="acre-input-help">Leave these alone and your one price is used for every year. Set them if what you get swings from year to year.</p>
          <div className="acre-input-table-wrap"><table><caption className="acre-input-sr-only">{readable(cropId)} low and high prices</caption><tbody>
            {(["low", "high"] as PriceCase[]).map(priceCase => <ValueRow key={priceCase} label={`Price · ${priceCase}`} title={priceCase === "low" ? "Price in a bad year" : "Price in a good year"} explanation={priceCase === "low" ? "The lowest price you would plan for." : "The highest price you would plan for."} units={PRICE_UNITS(cur)} reference={priceRef(priceCase)} override={overrides.price?.[priceCase]} onChange={quantity => update(cropId, { ...overrides, price: { ...overrides.price, [priceCase]: quantity } })} onReset={() => resetCase(priceCase)} />)}
          </tbody></table></div>
        </details>
        {defaults?.confidence ? <details className="acre-input-more-prices"><summary>How well supported are these numbers?</summary><p className="acre-input-help">The share of these numbers that come from you or from a traceable source. It is not a chance of being right.</p><ConfidenceBadge value={defaults.confidence} label="Default input support" /></details> : null}
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
        {!costItems.length && <p className="acre-input-help">No costs yet. Without costs, the money result is what the crop sells for, not what is left.</p>}
        <div className="acre-input-inline"><label>Another cost item<input placeholder="For example, seed or fuel" value={costNames[cropId] ?? ""} onChange={event => setCostNames({ ...costNames, [cropId]: event.target.value })} /></label><button type="button" disabled={!costNames[cropId]?.trim() || costItems.includes(costNames[cropId]?.trim() ?? "")} onClick={() => { const name = costNames[cropId]?.trim(); if (name) { update(cropId, { ...overrides, costs: { ...overrides.costs, [name]: { value: null, unit: "", origin: "grower" } } }); setCostNames({ ...costNames, [cropId]: "" }); } }}>Add cost item</button></div>
      </section>;
    })}
    {!!request.data?.gaps.length && <ul aria-label="Economics gaps">{request.data.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>}</>}
    {losses && <fieldset className="acre-input-loss"><legend>Your estimate of weather losses</legend>
      <p>Pick the closest answer. These are your own estimates, not measured losses.</p>
      {(["dry_spring_pct", "heavy_rain_pct"] as const).map(kind => {
        const current = value.loss_assumptions[kind];
        const set = (pct: number | null) => onChange({ ...value, loss_assumptions: { ...value.loss_assumptions, [kind]: pct } });
        const question = kind === "dry_spring_pct" ? (winter ? "In a dry spring, how much of the harvest do you lose?" : "When it is too dry at planting, how much of the harvest do you lose?") : "When heavy rain falls on bare ground, how much do you lose?";
        return <div key={kind} className="acre-input-loss-question" role="group" aria-label={question}>
          <p className="acre-input-loss-q">{question}</p>
          <div className="acre-input-loss-choices">
            {LOSS_CHOICES.map(choice => <button key={choice.pct} type="button" aria-pressed={current === choice.pct} onClick={() => set(choice.pct)}><span className="acre-input-loss-meter" aria-hidden="true"><i style={{ width: `${choice.pct}%` }} /></span>{choice.label}</button>)}
            <button type="button" aria-pressed={current == null} onClick={() => set(null)}>I don't know</button>
          </div>
          <label className="acre-input-loss-exact">Or enter a number<input aria-label={kind === "dry_spring_pct" ? "Dry spring yield loss percent" : "Heavy rain yield loss percent"} type="number" min="0" max="100" step="any" placeholder="%" value={current ?? ""} onChange={event => {
            const number = event.target.value === "" ? null : Number(event.target.value);
            if (number === null || Number.isFinite(number) && number >= 0 && number <= 100) set(number);
          }} />% of the harvest</label>{current != null ? <span>Your estimate <OriginLabel origin="assumed" /></span> : null}
        </div>;
      })}
      <p className="acre-input-help">With "I don't know", weather risk and money results are shown side by side and never combined.</p>
    </fieldset>}
  </section>;
}
