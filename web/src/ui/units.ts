import { useSyncExternalStore } from "react";

/*
  One "Units" setting for the whole app (card 15): hectares or acres, millimetres or inches,
  °C or °F, and the currency the grower usually works in. It is first set from the field's
  country and can be changed in one place; once the grower has chosen, it is never changed
  for them. Everything is stored and sent to the service in metric: this file only changes
  how a number is shown or typed. Saved in this browser (`acre.units.v1`).
*/
export interface Units {
  area: "ha" | "ac";
  rain: "mm" | "in";
  temp: "C" | "F";
  /** ISO code of the currency the grower usually prices in; null when not known. Display money always uses the currency that was entered. */
  currency: string | null;
  /** True once the grower has set a unit by hand. */
  chosen: boolean;
}

const KEY = "acre.units.v1";
/** Countries that farm in acres, inches and Fahrenheit. */
const IMPERIAL = new Set(["US", "USA", "LR", "LBR", "MM", "MMR"]);
/** The usual currency by country (ISO 3166 alpha-2). A country missing here simply has no suggestion. */
const CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", UY: "UYU", PY: "PYG", BO: "BOB", EC: "USD",
  GB: "GBP", IE: "EUR", FR: "EUR", DE: "EUR", ES: "EUR", PT: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", GR: "EUR", FI: "EUR",
  PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", SE: "SEK", NO: "NOK", DK: "DKK", CH: "CHF", UA: "UAH", RU: "RUB", TR: "TRY",
  KE: "KES", UG: "UGX", TZ: "TZS", RW: "RWF", ET: "ETB", NG: "NGN", GH: "GHS", SN: "XOF", CI: "XOF", ML: "XOF", BF: "XOF", CM: "XAF",
  ZA: "ZAR", ZM: "ZMW", ZW: "USD", MW: "MWK", MZ: "MZN", EG: "EGP", MA: "MAD", DZ: "DZD", TN: "TND", SD: "SDG",
  IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR", CN: "CNY", JP: "JPY", KR: "KRW", VN: "VND", TH: "THB", ID: "IDR", PH: "PHP",
  MY: "MYR", MM: "MMK", KH: "KHR", AU: "AUD", NZ: "NZD", SA: "SAR", IR: "IRR", IQ: "IQD", IL: "ILS", KZ: "KZT", UZ: "UZS",
};
const ALPHA3: Record<string, string> = { USA: "US", KEN: "KE", IND: "IN", DEU: "DE", BRA: "BR", ARG: "AR", GBR: "GB", NGA: "NG", ETH: "ET", TZA: "TZ", UGA: "UG", ZAF: "ZA", MEX: "MX", CAN: "CA", AUS: "AU", FRA: "FR", ESP: "ES", ITA: "IT", CHN: "CN", IDN: "ID", PAK: "PK", BGD: "BD", VNM: "VN", THA: "TH", PHL: "PH", EGY: "EG", GHA: "GH", TUR: "TR", UKR: "UA", POL: "PL", LBR: "LR", MMR: "MM" };

/** The units a country's growers usually use. An unknown country gets metric and no currency. */
export function unitsForCountry(country: string | null | undefined): Omit<Units, "chosen"> {
  const raw = (country ?? "").trim().toUpperCase();
  const code = ALPHA3[raw] ?? raw;
  const imperial = IMPERIAL.has(code);
  return { area: imperial ? "ac" : "ha", rain: imperial ? "in" : "mm", temp: imperial ? "F" : "C", currency: CURRENCY[code] ?? null };
}

function browserCountry(): string | null {
  try {
    return typeof navigator !== "undefined" ? (new Intl.Locale(navigator.language).region ?? null) : null;
  } catch {
    return null;
  }
}

let cache: Units | null = null;
const listeners = new Set<() => void>();
function read(): Units {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Units>;
      if ((v.area === "ha" || v.area === "ac") && (v.rain === "mm" || v.rain === "in") && (v.temp === "C" || v.temp === "F")) {
        cache = { area: v.area, rain: v.rain, temp: v.temp, currency: typeof v.currency === "string" && v.currency ? v.currency : null, chosen: Boolean(v.chosen) };
        return cache;
      }
    }
  } catch {
    /* an unreadable setting falls back to the default below */
  }
  cache = { ...unitsForCountry(browserCountry()), chosen: false };
  return cache;
}
function write(next: Units) {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: the setting lasts for this visit */
  }
  listeners.forEach((l) => l());
}

export const getUnits = (): Units => read();
/** The grower changes a unit: it is theirs from now on. */
export function setUnits(patch: Partial<Omit<Units, "chosen">>) {
  write({ ...read(), ...patch, chosen: true });
}
/** A field's country is known: follow it, unless the grower has already chosen. */
export function suggestUnits(country: string | null | undefined) {
  const cur = read();
  if (cur.chosen || !country) return;
  const next = unitsForCountry(country);
  if (next.area !== cur.area || next.rain !== cur.rain || next.temp !== cur.temp || next.currency !== cur.currency) write({ ...next, chosen: false });
}
export function useUnits(): Units {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    read,
  );
}
export function resetUnitsForTests(u?: Partial<Units>) {
  cache = u ? { area: "ac", rain: "mm", temp: "C", currency: null, chosen: true, ...u } : null;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
  listeners.forEach((l) => l());
}

// ------------------------------------------------------------------ showing numbers
/** Numbers are written the way the grower's own browser writes them (1,234.5 or 1.234,5). */
export const LOCALE: string | undefined = undefined;
const SQ_M_PER_HA = 10_000;
const SQ_M_PER_AC = 4046.8564224;
const MM_PER_IN = 25.4;
const areaDigits = (v: number) => (v >= 100 ? 0 : v >= 10 ? 1 : 2);
const fmt = (v: number, digits: number) => v.toLocaleString(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** A field's size in the grower's unit first, and in the other unit for anyone who thinks in it. */
export function areaText(m2: number, u: Units = read()): { main: string; other: string } {
  const ha = m2 / SQ_M_PER_HA;
  const ac = m2 / SQ_M_PER_AC;
  const haText = `${fmt(ha, areaDigits(ha))} ha`;
  const acText = `${fmt(ac, areaDigits(ac))} ac`;
  return u.area === "ha" ? { main: haText, other: acText } : { main: acText, other: haText };
}
export const areaWord = (u: Units = read()) => (u.area === "ha" ? "hectares" : "acres");

/**
 * A measured amount in the grower's units. Only millimetres of rain and degrees Celsius are
 * converted; every other unit is returned exactly as given.
 */
export function convert(value: number, unit: string | null | undefined, u: Units = read()): { value: number; unit: string | null; converted: boolean } {
  const t = (unit ?? "").trim();
  if (u.rain === "in" && /^mm\b/.test(t)) return { value: value / MM_PER_IN, unit: t.replace(/^mm\b/, "in"), converted: true };
  if (u.temp === "F" && /^°\s?C\b/.test(t)) return { value: (value * 9) / 5 + 32, unit: t.replace(/^°\s?C\b/, "°F"), converted: true };
  return { value, unit: unit ?? null, converted: false };
}
/** "64 mm" or "2.5 in": rain in the grower's unit. */
export function rainText(mm: number, digits = 0, u: Units = read()): string {
  return u.rain === "in" ? `${fmt(mm / MM_PER_IN, Math.max(1, digits))} in` : `${fmt(mm, digits)} mm`;
}
export const rainUnit = (u: Units = read()) => (u.rain === "in" ? "in" : "mm");
export const tempUnit = (u: Units = read()) => (u.temp === "F" ? "°F" : "°C");
/** What the grower typed, back to the metric value that is stored and sent. */
export const rainToMm = (v: number, u: Units = read()) => (u.rain === "in" ? Math.round(v * MM_PER_IN * 10) / 10 : v);
export const tempToC = (v: number, u: Units = read()) => (u.temp === "F" ? Math.round((((v - 32) * 5) / 9) * 10) / 10 : v);
/** A value with its unit, converted where the grower's units differ: "12.5 mm" -> "0.5 in". */
export function qtyText(value: number | null | undefined, unit: string | null | undefined, u: Units = read()): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const c = convert(value, unit, u);
  const digits = c.converted ? 1 : Number.isInteger(value) ? 0 : 2;
  return c.unit ? `${fmt(c.value, digits)} ${c.unit}` : fmt(c.value, digits);
}

/** "12 April 2027": day, month in words, year. Read the same way everywhere, unlike 04/12/2027. */
export function longDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return iso ?? "";
  const month = new Intl.DateTimeFormat(LOCALE, { month: "long", timeZone: "UTC" }).format(d);
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/** A label that names its unit ("Rainfall (mm, own gauge)") in the unit the value beside it is shown in. */
export function unitLabel(label: string, u: Units = read()): string {
  let out = label;
  if (u.rain === "in") out = out.replace(/\(mm\b/g, "(in");
  if (u.temp === "F") out = out.replace(/°\s?C\b/g, "°F");
  return out;
}
