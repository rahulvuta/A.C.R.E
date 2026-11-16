import type { CropOverride } from "../../api/simModel";
import type { EconomicsValue, Quantity } from "../../inputs";
import type { SimField } from "../../state/simField";

const quantity = (q: { value: number; unit: string }): Quantity => ({ ...q, origin: "grower" });
export function economicsValue(sim: SimField): EconomicsValue {
  if (sim.economicsInputs) return { ...sim.economicsInputs, loss_assumptions: { dry_spring_pct: sim.loss.drySpringPct, heavy_rain_pct: sim.loss.heavyRainPct } };
  return {
    overrides: Object.fromEntries(Object.entries(sim.overrides).map(([id, o]) => [id, {
      ...(o.priceCases ? { price: Object.fromEntries(Object.entries(o.priceCases).map(([k, q]) => [k, quantity(q)])) } : o.price ? { price: { low: quantity(o.price), typical: quantity(o.price), high: quantity(o.price) } } : {}),
      ...(o.yield ? { yield: quantity(o.yield) } : {}),
      ...(o.costItems?.length ? { costs: Object.fromEntries(o.costItems.map(({ item, ...q }) => [item, quantity(q)])) } : o.costPerArea ? { costs: { total: quantity(o.costPerArea) } } : {}),
    }])),
    loss_assumptions: { dry_spring_pct: sim.loss.drySpringPct, heavy_rain_pct: sim.loss.heavyRainPct },
  };
}
export function simulationOverrides(value: EconomicsValue): Record<string, CropOverride> {
  const valid = (q: Quantity | undefined) => q?.value != null && Number.isFinite(q.value) && q.unit.trim() ? { value: q.value, unit: q.unit.trim() } : null;
  return Object.fromEntries(Object.entries(value.overrides).map(([id, o]) => [id, {
    priceCases: Object.fromEntries(Object.entries(o.price ?? {}).flatMap(([k, q]) => { const v = valid(q); return v ? [[k, v]] : []; })),
    yield: valid(o.yield),
    ...(o.costs?.total ? { costPerArea: valid(o.costs.total) } : { costItems: Object.entries(o.costs ?? {}).flatMap(([item, q]) => { const v = valid(q); return v ? [{ item, ...v }] : []; }) }),
  }]));
}
export function economicsReady(sim: SimField): boolean {
  if (!sim.economicsInputs) return true;
  return Object.values(sim.economicsInputs.overrides).every(o => {
    const prices = Object.values(o.price ?? {});
    const quantities = [...prices, ...(o.yield ? [o.yield] : []), ...Object.values(o.costs ?? {})];
    return (!prices.length || prices.length === 3 && new Set(prices.map(q => q.unit.trim())).size === 1) && quantities.every(q => q.value != null && Number.isFinite(q.value) && q.unit.trim());
  });
}
