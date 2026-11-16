import { OriginLabel } from "./shared";
export interface AreaSummaryProps { areaHa: number | null | undefined }
export function AreaSummary({ areaHa }: AreaSummaryProps) {
  const valid = areaHa != null && Number.isFinite(areaHa) && areaHa >= 0;
  const format = (number: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number);
  return <section className="acre-inputs acre-input-card acre-input-area" aria-label="Field area"><h2>Field area</h2><dl><div><dt>Acres</dt><dd>{valid ? format(areaHa * 2.471053814671653) : "Not available"} <OriginLabel origin="calculation" /></dd></div><div><dt>Hectares</dt><dd>{valid ? format(areaHa) : "Not available"} <OriginLabel origin="calculation" /></dd></div></dl><p className="acre-input-help">Both numbers describe the same field area; acres are converted from the supplied hectares for display.</p></section>;
}
