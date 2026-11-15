import type { Dist, Odds } from "../../api/simModel";

/* Formatting only: every number here is the backend's, shown as it came. Blank stays blank. */
export const NA = "Not available";

export function money(v: number | null | undefined, currency: string | null = "USD"): string {
  if (v == null) return NA;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${Math.round(v).toLocaleString("en-US")} ${currency ?? ""}`.trim();
  }
}
export function num(v: number | null | undefined, unit?: string | null, digits = 0): string {
  if (v == null) return NA;
  const s = v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return unit ? `${s} ${unit}` : s;
}
export const pct = (p: number | null | undefined) => (p == null ? NA : `${Math.round(p * 100)}%`);
export const isDist = (x: Dist | Odds | number | null | undefined): x is Dist => !!x && typeof x === "object" && "median" in x;
export const isOdds = (x: Dist | Odds | number | null | undefined): x is Odds => !!x && typeof x === "object" && "probability" in x;

/** "p10 to p90" when the backend gave both ends; otherwise nothing. */
export function range(d: Dist | null | undefined, fmt: (v: number | null) => string): string | null {
  return d && d.p10 != null && d.p90 != null ? `${fmt(d.p10)} to ${fmt(d.p90)}` : null;
}

export const cropLabel = (id: string) => (id ? id.replace(/^other:/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");

const INDICATOR_LABEL: Record<string, string> = {
  margin_10y: "10-year margin",
  living_cover_days_per_year: "Living cover",
  living_cover_days: "Living cover",
  rain_on_bare_soil_mm_per_year: "Rain on bare soil",
  rain_on_bare_soil_mm: "Rain on bare soil",
  dry_pre_plant: "Dry before planting",
  crop_families: "Crop families",
  operations_per_year: "Field passes a year",
};
export const indicatorLabel = (k: string) => INDICATOR_LABEL[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const BADGE_LABEL: Record<string, string> = {
  best_profit: "Highest estimated margin of these plans",
  most_sustainable: "Most sustainable",
  lowest_weather_risk: "Lowest weather risk",
  best_for_priorities: "Best for your priorities",
};
