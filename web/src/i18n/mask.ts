/*
  Numbers, money and units never go to the translator (card 18). Before a sentence is
  translated each of them is swapped for a placeholder ("About 682 mm" -> "About {0}"), and the
  same text is put back, untouched, into the translation. So "682 mm" and "534 mm" share one
  saved sentence, and no number, currency or unit can be changed by a translation.
*/
const PLACEHOLDER = /\{(\d+)\}/g;
/*
  What is taken out, in one pass:
  - money, code and amount together: "KES 181,560";
  - a number, with a unit written right after it: "341 mm", "3.4 ha", "19 °C", "90 kg";
  - a unit made of two parts: "KES/bag", "USD/t", "t/ha" (the grower types these as written);
  - a currency code standing alone: "KES".
  A translator once turned "KES" into another country's money; taking these out makes that
  impossible, the same way it is for numbers.
*/
const NUM = String.raw`\d+(?:[.,]\d+)*`;
const UNIT = String.raw`(?:\s?(?:mm|ha|ac|kg|km|t|°\s?C|°\s?F)(?![\p{L}\p{N}]))?`;
const PAIR = String.raw`(?<![\p{L}\p{N}])(?:[A-Z]{3}|kg|t|q|bu|lb|bag|bags)\/(?:t|kg|q|bag|ha|ac|bu|lb)(?![\p{L}\p{N}])`;
const TOKEN = new RegExp(`${PAIR}|(?:(?<![\\p{L}\\p{N}])([A-Z]{3})\\s)?(${NUM})${UNIT}|(?<![\\p{L}\\p{N}])([A-Z]{3})(?![\\p{L}\\p{N}])`, "gu");

let codes: Set<string> | null = null;
/** True for an ISO currency code (KES, INR, USD...), from the browser's own list. */
function isCurrency(code: string): boolean {
  if (!codes) {
    try {
      codes = new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency"));
    } catch {
      codes = new Set(["USD", "EUR", "GBP", "KES", "UGX", "TZS", "NGN", "GHS", "ZAR", "ETB", "XOF", "XAF", "INR", "PKR", "BDT", "CNY", "IDR", "PHP", "VND", "BRL", "ARS", "MXN", "COP", "CAD", "AUD"]);
    }
  }
  return codes.has(code);
}

export interface Masked {
  /** Whitespace around the text, kept exactly. */
  lead: string;
  trail: string;
  /** The sentence with its numbers taken out; this is what is translated and saved. */
  key: string;
  numbers: string[];
}

export function mask(text: string): Masked {
  const lead = /^\s*/.exec(text)![0];
  const trail = lead.length === text.length ? "" : /\s*$/.exec(text)![0];
  const core = text.slice(lead.length, text.length - trail.length);
  const numbers: string[] = [];
  // Text that already holds something like "{0}" is left alone, so a real brace is never mistaken for a number's place.
  if (PLACEHOLDER.test(core)) {
    PLACEHOLDER.lastIndex = 0;
    return { lead, trail, key: "", numbers };
  }
  const hold = (text: string) => `{${numbers.push(text) - 1}}`;
  const key = core.replace(TOKEN, (all: string, code: string | undefined, num: string | undefined, lone: string | undefined) => {
    if (num !== undefined) {
      // "KES 181,560" goes out whole; a capital word that is not money ("ACRE 2") keeps its word.
      if (code && !isCurrency(code)) return `${code} ${hold(all.slice(code.length + 1))}`;
      return hold(all);
    }
    if (lone !== undefined) return isCurrency(lone) ? hold(all) : all;
    return hold(all);
  });
  return { lead, trail, key, numbers };
}

/** The translated sentence with every number back in its place; null when a placeholder is missing or repeated. */
export function unmask(translated: string, m: Masked): string | null {
  const seen = new Set<number>();
  let ok = true;
  const out = translated.replace(PLACEHOLDER, (_all, i: string) => {
    const n = Number(i);
    if (n >= m.numbers.length || seen.has(n)) ok = false;
    seen.add(n);
    return m.numbers[n] ?? "";
  });
  if (!ok || seen.size !== m.numbers.length) return null;
  return m.lead + out + m.trail;
}

/** Worth translating: it has words, and is not longer than one paragraph. */
export const translatable = (key: string) => key.length > 0 && key.length <= 1500 && /\p{L}{2,}/u.test(key);
