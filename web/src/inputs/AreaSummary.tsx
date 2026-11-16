import { OriginLabel } from "./shared";
import { getUnits, LOCALE } from "../ui/units";
export interface AreaSummaryProps { areaHa: number | null | undefined }
export function AreaSummary({ areaHa }: AreaSummaryProps) {
  const valid = areaHa != null && Number.isFinite(areaHa) && areaHa >= 0;
  const format = (number: number) => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(number);
  return <section className="acre-inputs acre-input-card acre-input-area" aria-label="Field area"><h2>Field area</h2><dl>{(getUnits().area === "ha" ? ["ha", "ac"] : ["ac", "ha"]).map(unit => <div key={unit}><dt>{unit === "ha" ? "Hectares" : "Acres"}</dt><dd>{valid ? format(unit === "ha" ? areaHa : areaHa * 2.471053814671653) : "Not available"} <OriginLabel origin="calculation" /></dd></div>)}</dl><p className="acre-input-help">Both numbers describe the same field area. Change which comes first under Units.</p></section>;
}
