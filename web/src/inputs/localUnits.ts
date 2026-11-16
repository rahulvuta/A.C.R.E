import type { Quantity } from "./schema";

/*
  Local selling units (card 16): bags, quintals and kilos. A grower who sells by the bag types
  "18 bags of 90 kg per acre" or "3,500 per bag"; the service works in tonnes. What was typed is
  kept beside the number that is sent, so it comes back in the same words. Only weights are
  converted here (kilos to tonnes); nothing about the crop is assumed, and a bag has no weight
  until the grower says how many kilos are in it.
*/
export interface LocalAmount {
  /** The number as typed. */
  value: number | null;
  /** The unit as picked: "bags/acre", "q/ha", "kg/acre", "KES/bag", "INR/q". */
  unit: string;
  /** Kilos in one bag, for a bag unit. */
  bag_kg: number | null;
}
export type LocalQuantity = Quantity & { local?: LocalAmount };

const KG_PER_QUINTAL = 100;
const KG_PER_TONNE = 1000;
type Measure = "bag" | "q" | "kg";
interface Parsed {
  kind: "yield" | "price";
  measure: Measure;
  /** "ha" or "acre" for a yield; the currency code for a price. */
  other: string;
}

/** A local unit this file converts, or null for a unit the service already understands (t/ha, USD/t, kg/ha, KES/kg). */
export function parseLocalUnit(unit: string | null | undefined): Parsed | null {
  const u = (unit ?? "").trim();
  const y = /^(bags?|q|quintals?|kg)\s*\/\s*(ha|hectares?|acres?|ac)$/i.exec(u);
  if (y) {
    const m = y[1]!.toLowerCase();
    const measure: Measure = m.startsWith("bag") ? "bag" : m === "kg" ? "kg" : "q";
    // "bags/ac" and "bags/acres" are the same unit as "bags/acre".
    const area = y[2]!.toLowerCase().startsWith("a") ? "acre" : "ha";
    // Kilos per hectare is a unit the service already takes; kilos per acre is converted here.
    if (measure === "kg" && area === "ha") return null;
    return { kind: "yield", measure, other: area };
  }
  const p = /^([A-Za-z]{3})\s*\/\s*(bags?|q|quintals?)$/i.exec(u);
  if (p) return { kind: "price", measure: p[2]!.toLowerCase().startsWith("bag") ? "bag" : "q", other: p[1]!.toUpperCase() };
  return null;
}
export const isBagUnit = (unit: string | null | undefined) => parseLocalUnit(unit)?.measure === "bag";

const kilos = (p: Parsed, bagKg: number | null) => (p.measure === "kg" ? 1 : p.measure === "q" ? KG_PER_QUINTAL : bagKg && bagKg > 0 ? bagKg : null);
const tidy = (v: number) => Number(v.toPrecision(6));

/** The amount in the service's units (tonnes per area, or currency per tonne); the value is null until a bag has a weight. */
export function toService(local: LocalAmount): { value: number | null; unit: string } | null {
  const p = parseLocalUnit(local.unit);
  if (!p) return null;
  const kg = kilos(p, local.bag_kg);
  const unit = p.kind === "yield" ? `t/${p.other}` : `${p.other}/t`;
  if (local.value == null || kg == null) return { value: null, unit };
  return { value: tidy(p.kind === "yield" ? (local.value * kg) / KG_PER_TONNE : (local.value / kg) * KG_PER_TONNE), unit };
}

/** A quantity from what the grower typed: local words kept, the service's number worked out. Other units pass straight through. */
export function fromTyped(value: number | null, unit: string, bagKg: number | null): LocalQuantity {
  const local: LocalAmount = { value, unit: unit.trim(), bag_kg: bagKg };
  const sent = toService(local);
  return sent ? { value: sent.value, unit: sent.unit, origin: "grower", local } : { value, unit, origin: "grower" };
}

const AREA_WORD: Record<string, string> = { ha: "hectare", acre: "acre" };
const num = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
/** The typed amount back in the grower's own words: "18 bags of 90 kg per acre", "3,500 KES per bag of 90 kg". */
export function inWords(q: LocalQuantity): string | null {
  const local = q.local;
  const p = local ? parseLocalUnit(local.unit) : null;
  if (!local || !p || local.value == null) return null;
  const one = p.measure === "bag" ? `bag${local.bag_kg ? ` of ${num(local.bag_kg)} kg` : ""}` : p.measure === "q" ? "quintal" : "kg";
  const many = p.measure === "bag" ? `bags${local.bag_kg ? ` of ${num(local.bag_kg)} kg` : ""}` : p.measure === "q" ? "quintals" : "kg";
  return p.kind === "yield" ? `${num(local.value)} ${local.value === 1 ? one : many} per ${AREA_WORD[p.other] ?? p.other}` : `${num(local.value)} ${p.other} per ${one}`;
}
/** The same amount as the service receives it, to show beside the grower's words: "1.62 tonnes per acre". */
export function sentWords(q: LocalQuantity): string | null {
  const p = q.local ? parseLocalUnit(q.local.unit) : null;
  if (!p || q.value == null) return null;
  return p.kind === "yield" ? `${num(q.value)} ${q.value === 1 ? "tonne" : "tonnes"} per ${AREA_WORD[p.other] ?? p.other}` : `${num(q.value)} ${p.other} per tonne`;
}

/** The local units offered for a yield, in the grower's area unit first. */
export const localYieldUnits = (acresFirst: boolean) => (acresFirst ? ["bags/acre", "q/acre", "kg/acre", "bags/ha", "q/ha"] : ["bags/ha", "q/ha", "bags/acre", "q/acre", "kg/acre"]);
/** The local units offered for a price in one currency. */
export const localPriceUnits = (currency: string) => [`${currency}/bag`, `${currency}/q`];
