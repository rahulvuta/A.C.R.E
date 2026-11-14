import type { Capability, FarmAnalysis, FieldAnalysis, RegionProfile } from "../../api/model";
import { CAPABILITY_LABEL, STATUS_TEXT } from "../../map/LocationCard";
import { OriginBadge } from "../../ui/OriginBadge";

/*
  What the backend found for one field (card D2/D3): its season wording, thresholds and rule
  lines, each with its origin badge, plus the resolution notices (shared weather cell, soil
  grid size, dataset calendars) and the per-capability states. Values are shown as returned.
*/
const fmt = (v: number | null | undefined, unit = "") => (v == null ? "Not available" : `${v}${unit ? ` ${unit}` : ""}`);

export function ResolutionNotices({ analysis, field, profile, caps }: { analysis: FarmAnalysis | null; field: FieldAnalysis | null; profile: RegionProfile | null; caps: Capability[] | null }) {
  const notes: string[] = [];
  const shared = field && analysis?.weatherCells.find((c) => c.cellId === field.cellId && c.fieldIds.length > 1);
  if (shared) notes.push(shared.note);
  else if (field?.cellId) notes.push("NASA POWER weather is one series for a cell about 0.5° by 0.625°; your boundary is exact, the weather is not field-level.");
  const soil = caps?.find((c) => c.key === "soil");
  if (soil?.provider === "soilgrids" || soil?.resolutionM === 250) notes.push("Soil comes from SoilGrids, a global model on a grid of about 250 m, not a soil test.");
  if (profile?.crops.some((c) => c.calendar?.origin === "dataset_estimate")) notes.push("Crop calendars here are dataset estimates (a global crop calendar at about 0.5°), not local dates. Edit them to yours.");
  if (!notes.length) return null;
  return (
    <ul className="fr-notices" aria-label="Resolution notices">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

export function CapabilityStates({ caps }: { caps: Capability[] | null }) {
  if (!caps?.length) return null;
  return (
    <dl className="fr-caps" aria-label="What A.C.R.E can use here">
      {caps.map((c) => (
        <div key={c.key} data-status={c.status}>
          <dt>{CAPABILITY_LABEL[c.key]}</dt>
          <dd>
            {STATUS_TEXT[c.status] ?? c.status}
            {c.origin ? <> <OriginBadge origin={c.origin} /></> : null}
            {c.reasonText ? <span className="fr-reason"> {c.reasonText}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function FieldResults({ field }: { field: FieldAnalysis }) {
  if (field.jobStatus === "pending")
    return (
      <p className="fr-state" role="status">
        Fetching 45 years of NASA weather for this field's cell. Results appear here when it is ready.
      </p>
    );
  const r = field.result;
  if (!r)
    return (
      <p className="fr-state" role="status">
        {STATUS_TEXT[field.status] ?? "Not available"}. {field.reasonText ?? "No results for this field yet."}
      </p>
    );
  const w = r.plan.winter;
  const cal = r.plan.calendar;
  const season = r.seasonLabel ?? "Winter";
  return (
    <div className="fr">
      <div className="db-tiles fr-tiles">
        <div className="db-tile">
          <span className="fr-num">{fmt(w?.per_season_median.rain_mm_without_cover, "mm")}</span>
          <span>median rain per {season.toLowerCase()} with nothing growing</span>
          <OriginBadge origin="calculation" />
        </div>
        <div className="db-tile">
          <span className="fr-num">{fmt(w?.per_season_median.heavy_rain_days_without_cover, "days")}</span>
          <span>
            heavy-rain days on bare soil{r.thresholds.heavyRain?.value != null ? ` (over ${r.thresholds.heavyRain.value} ${r.thresholds.heavyRain.unit})` : ""}
          </span>
          {r.thresholds.heavyRain ? <OriginBadge origin={r.thresholds.heavyRain.origin} /> : null}
        </div>
        <div className="db-tile">
          <span className="fr-num">{fmt(cal?.living_cover_days_planned, "days")}</span>
          <span>of planned living cover</span>
          <OriginBadge origin="calculation" />
        </div>
      </div>
      <p className="fr-line">
        {season} and {r.springLabel ?? "30 days before planting"}
        {r.hemisphere ? ` · ${r.hemisphere === "south" ? "Southern" : "Northern"} Hemisphere` : ""}
        {field.scope === "nc" ? " · NC State rules apply" : " · NC rules do not apply here"}
      </p>
      {r.thresholds.drySpring ? (
        <p className="fr-line">
          Dry spring cutoff: {fmt(r.thresholds.drySpring.value, r.thresholds.drySpring.unit)} <OriginBadge origin={r.thresholds.drySpring.origin} />
        </p>
      ) : null}
      {r.rules.length ? (
        <>
          <h3>Checks for this plan</h3>
          <ul className="fr-rules">
            {r.rules.map((x) => (
              <li key={x.ruleId} data-origin={x.origin}>
                <span>{x.text}</span> <OriginBadge origin={x.origin} />
                {x.source ? x.source.url ? <a href={x.source.url} target="_blank" rel="noreferrer">{x.source.title}</a> : <span>{x.source.title}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
