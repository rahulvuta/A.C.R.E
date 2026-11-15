import { useCallback, useState } from "react";
import { inputsApi, type InputsApi } from "./api";
import type { CropOverrides, EconomicsValue, InputArea, InputLocation, PriceCase, Quantity } from "./schema";
import { ErrorNotice, OriginLabel, SourceLabel, display, readable, useInputRequest } from "./shared";

export interface EconomicsEditorProps {
  location: InputLocation; crops: string[]; area: InputArea; value: EconomicsValue;
  onChange: (value: EconomicsValue) => void; api?: InputsApi;
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
export function EconomicsEditor({ location, crops, area, value, onChange, api = inputsApi }: EconomicsEditorProps) {
  const uniqueCrops = [...new Set(crops)];
  const key = JSON.stringify({ location, crops: uniqueCrops, area });
  const loader = useCallback((signal: AbortSignal) => api.estimate({ location, crops: uniqueCrops, area, equipment: [], overrides: {} }, signal), [api, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const request = useInputRequest(key, loader, uniqueCrops.length > 0);
  const [costNames, setCostNames] = useState<Record<string, string>>({});
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
  return <section className="acre-inputs acre-input-card" aria-label="Prices, yields and costs"><h2>Your prices, yields and costs</h2>
    <p>Use local references or enter your own numbers and units. The service calculates money results from these inputs.</p>
    {request.loading && <p role="status">Looking up regional references…</p>}
    {request.error && <ErrorNotice error={request.error} retry={request.retry} />}
    {!uniqueCrops.length && <p>Choose crops to enter their prices, yields and costs.</p>}
    {uniqueCrops.map(cropId => {
      const defaults = request.data?.crops.find(crop => crop.crop_id === cropId || crop.aliases.includes(cropId));
      const overrides = value.overrides[cropId] ?? {};
      const costItems = overrides.costs?.total ? ["total"] : [...new Set([...(defaults?.costs.items.map(item => item.item) ?? []), ...Object.keys(overrides.costs ?? {})])];
      return <section key={cropId} className="acre-input-economics-crop" aria-label={`${readable(cropId)} economics`}><h3>{readable(cropId)}</h3>
        {defaults?.reason_text && <p>{defaults.reason_text}</p>}
        {defaults?.status && defaults.status !== "complete" && <p>Reference coverage: {readable(defaults.status)}</p>}
        <div className="acre-input-table-wrap"><table><caption className="acre-input-sr-only">{readable(cropId)} price cases, yield and costs</caption><thead><tr><th scope="col">Input</th><th scope="col">Value and unit to use</th><th scope="col">Regional default and source</th><th scope="col">Restore default</th></tr></thead><tbody>
          {(["low", "typical", "high"] as PriceCase[]).map(priceCase => <ValueRow key={priceCase} label={`Price · ${priceCase}`} explanation={priceCase === "typical" ? "The middle price case for one unit of harvested crop." : `The ${priceCase === "low" ? "lower" : "upper"} price case for one unit of harvested crop.`} reference={defaults?.price ? { ...defaults.price, value: defaults.price[priceCase] } : undefined} override={overrides.price?.[priceCase]} onChange={quantity => update(cropId, { ...overrides, price: { ...overrides.price, [priceCase]: quantity } })} onReset={() => { const price = { ...overrides.price }; delete price[priceCase]; update(cropId, { ...overrides, price }); }} />)}
          <ValueRow label="Yield" explanation="The harvested amount per acre or hectare, in the unit shown." reference={defaults?.yield} override={overrides.yield} onChange={quantity => update(cropId, { ...overrides, yield: quantity })} onReset={() => { const next = { ...overrides }; delete next.yield; update(cropId, next); }} />
          {costItems.map(item => <ValueRow key={item} label={`Cost · ${readable(item)}`} explanation="The cost of this item per acre or hectare, in the unit shown." reference={defaults?.costs.items.find(cost => cost.item === item)} override={overrides.costs?.[item]} onChange={quantity => update(cropId, { ...overrides, costs: { ...overrides.costs, [item]: quantity } })} onReset={() => { const costs = { ...overrides.costs }; delete costs[item]; update(cropId, { ...overrides, costs }); }} />)}
        </tbody></table></div>
        {!costItems.length && <p>Cost items: Not available. Add a cost you know.</p>}
        <div className="acre-input-inline"><label>Another cost item<input placeholder="For example, seed or fuel" value={costNames[cropId] ?? ""} onChange={event => setCostNames({ ...costNames, [cropId]: event.target.value })} /></label><button type="button" disabled={!costNames[cropId]?.trim() || costItems.includes(costNames[cropId]?.trim() ?? "")} onClick={() => { const name = costNames[cropId]?.trim(); if (name) { update(cropId, { ...overrides, costs: { ...overrides.costs, [name]: { value: null, unit: "", origin: "grower" } } }); setCostNames({ ...costNames, [cropId]: "" }); } }}>Add cost item</button></div>
      </section>;
    })}
    {!!request.data?.gaps.length && <ul aria-label="Economics gaps">{request.data.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>}
    <fieldset className="acre-input-loss"><legend>Your estimate of weather losses</legend><p>These percentages are your estimates of lost yield; they are not measured or modeled losses. Leave them blank if unknown.</p>
      {(["dry_spring_pct", "heavy_rain_pct"] as const).map(kind => <div key={kind}><label>{kind === "dry_spring_pct" ? "In a dry spring I lose about" : "In a heavy-rain year I lose about"}<input aria-label={kind === "dry_spring_pct" ? "Dry spring yield loss percent" : "Heavy rain yield loss percent"} type="number" min="0" max="100" step="any" placeholder="Not available" value={value.loss_assumptions[kind] ?? ""} onChange={event => {
        const number = event.target.value === "" ? null : Number(event.target.value);
        if (number === null || Number.isFinite(number) && number >= 0 && number <= 100) onChange({ ...value, loss_assumptions: { ...value.loss_assumptions, [kind]: number } });
      }} />% of yield</label><span>Your estimate <OriginLabel origin="assumed" /></span></div>)}
      <p className="acre-input-help">Without an estimate, weather risk and money results stay separate.</p>
    </fieldset>
  </section>;
}
