import type { Dist } from "./types";
import { LOCALE } from "../ui/units";

/** "$13,100" / "−$1,200"; blank (null) is "Not available", never $0. */
export function money(v: number | null | undefined, currency?: string | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "Not available";
  // With no currency the figure is a plain number: a dollar sign is never assumed.
  const s = currency ? new Intl.NumberFormat(LOCALE, { style: "currency", currency, maximumFractionDigits: 0 }).format(Math.abs(v)) : Math.round(Math.abs(v)).toLocaleString(LOCALE);
  return v < 0 ? `−${s}` : s;
}

export function moneyRange(d: Dist | undefined | null): string | null {
  if (!d || d.p10 == null || d.p90 == null) return null;
  return `${money(d.p10, d.currency)} to ${money(d.p90, d.currency)}`;
}

/** 0.38 → "38%". */
export const pct = (p: number) => `${Math.round(p * 100)}%`;

export const OUTLOOK_NOTE = "An evidence-based outlook from this field's real past seasons. It shows what to plan for under conditions seen here; it cannot say what any single year will bring.";
