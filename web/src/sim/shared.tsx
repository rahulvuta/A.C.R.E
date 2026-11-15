import type { Distribution, Origin, Reason, Scenario, ScenarioEvent, SummaryValue } from "./schema";

export const HISTORY_NOTE = "Replays real past weather in new orders; not a forecast.";
export const COMPARISON_CAVEAT = "Best of the scenarios you compared, given these numbers and past weather. Not a forecast.";
export const readable = (text: string) => text.replaceAll("_", " ");
export const formatNumber = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Not available" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
export function formatMoney(value: number | null | undefined, currency?: string) {
  if (value == null || !Number.isFinite(value)) return "Not available";
  if (!currency) return `${formatNumber(value)} (currency not available)`;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value); }
  catch { return `${formatNumber(value)} ${currency}`; }
}
export function OriginLabel({ origin }: { origin?: Origin | null }) {
  return <span className={`sim-origin sim-origin-${origin ?? "missing"}`} data-origin={origin ?? "missing"}>{origin ?? "Origin not available"}</span>;
}
export function SourceLink({ source }: { source?: Distribution["source"] }) {
  if (!source?.title) return null;
  return source.url && /^https?:\/\//i.test(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <span>{source.title}</span>;
}
export function Value({ value, origin, unit, currency, money = false }: { value?: number | null; origin?: Origin | null; unit?: string; currency?: string; money?: boolean }) {
  return <span className="sim-value-pair"><span>{money || currency ? formatMoney(value, currency) : formatNumber(value)}{value != null && !money && !currency && unit ? ` ${unit}` : ""}</span><OriginLabel origin={origin} /></span>;
}
export function asDistribution(value?: SummaryValue): Distribution | undefined {
  if (value == null) return undefined;
  return typeof value === "number" ? { median: value } : value;
}
export function SummaryMetric({ label, value, unit, caption }: { label: string; value?: SummaryValue; unit?: string; caption: string }) {
  const data = asDistribution(value);
  return <div className="sim-metric"><dt>{label}</dt><dd><Value value={data?.median !== undefined ? data.median : data?.value} unit={data?.unit ?? unit} origin={data?.origin} /></dd><p>{caption}</p>{data?.reason_text && <p>{data.reason_text}</p>}<SourceLink source={data?.source} /></div>;
}
export function ReasonText({ reason }: { reason: Reason }) {
  if (typeof reason === "string") return <>{reason}<OriginLabel /></>;
  return <>{reason.crop_id && `${readable(reason.crop_id)}: `}{reason.reason_text || reason.text || reason.reason || "Not available"}<OriginLabel origin={reason.origin} /></>;
}
export function MarginSummary({ margin }: { margin?: Distribution | null }) {
  return <div className="sim-margin"><p className="sim-label">10-year margin, median</p><div className="sim-headline"><span>{formatMoney(margin?.median, margin?.currency)}</span><OriginLabel origin={margin?.origin} /></div><p>Money left after the costs included in this plan, over the whole field.</p><p className="sim-range">p10: <Value value={margin?.p10} currency={margin?.currency} money origin={margin?.origin} /> <span>to p90: </span><Value value={margin?.p90} currency={margin?.currency} money origin={margin?.origin} /></p><p className="sim-muted">The p10–p90 range contains the middle 80% of historical replays; the median is the middle result.</p><SourceLink source={margin?.source} /></div>;
}
const assumptionLabels: Record<string, string> = { dry_spring_pct: "dry-spring loss estimate", heavy_rain_pct: "heavy-rain loss estimate" };
export function MoneyContext({ scenario }: { scenario: Scenario }) {
  const assumptions = [...new Set([scenario.totals?.margin_10y, ...scenario.yearly.map(y => y.money?.margin)].flatMap(margin => {
    const value = margin?.includes_assumption;
    return typeof value === "string" ? [value] : value ?? [];
  }))];
  return <div className="sim-money-context"><p>Money inputs: {readable(scenario.money_status)}.</p>{scenario.money_gaps.length > 0 ? <ul>{scenario.money_gaps.map((gap, index) => <li key={index}><ReasonText reason={gap} /></li>)}</ul> : scenario.money_status !== "complete" ? <p>Some money inputs are missing or still need checking. The service did not provide a reason.</p> : null}{assumptions.length ? <p>Includes your {assumptions.map(a => assumptionLabels[a] ?? readable(a)).join(" and ")}. Weather affects money only through this estimate.<OriginLabel origin="assumed" /></p> : <p>Money and weather risk are shown separately. No weather-loss assumption was returned.</p>}</div>;
}
const eventLabels: Record<string, string> = {
  dry_springs_ge_3_in_10y: "3 or more dry springs in 10 years",
  heavy_rain_ge_3_in_10y: "3 or more heavy-rain seasons in 10 years",
};
export function EventOdds({ events }: { events: ScenarioEvent[] }) {
  if (!events.length) return <p className="sim-muted">Not available. No event odds were returned.</p>;
  return <ul className="sim-events">{events.map((event, index) => <li key={`${event.event}-${index}`}><p>{event.text || eventLabels[event.event] || `The service tracked this event: ${readable(event.event)}.`}<OriginLabel origin={event.origin} /></p><p className="sim-muted">{event.probability == null ? "Event odds: Not available." : `${new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(event.probability)} of historical replays included this event.`}<OriginLabel origin={event.origin} /></p></li>)}</ul>;
}
