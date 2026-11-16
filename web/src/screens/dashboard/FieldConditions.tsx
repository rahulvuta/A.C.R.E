import { useEffect, useMemo, useState } from "react";
import { toBackendReading } from "../../api/adapt";
import { farmActions } from "../../farm/hooks";
import type { ConditionAssessment, FieldConditionsResponse } from "../../inputs/conditions";
import { updateSimField } from "../../state/simField";
import { cropsOf, simCrops, type StepContext } from "../guided/context";
import { cropLabel } from "../guided/format";
import { ReadingsLog } from "../guided/StepPlan";
import { ResearchPanel } from "../workspace/ResearchPanel";
import { qtyText, unitLabel } from "../../ui/units";

const conditionRequest = ({ point, sim, regionKey }: StepContext) => ({
  location: point, readings: sim.readings.map(toBackendReading),
  crops: [...new Set([...simCrops(sim), ...cropsOf(sim.scenarios.flatMap(s => s.rotation))])].sort(),
  region_key: regionKey ?? "unknown",
});

export function FieldConditions({ ctx }: { ctx: StepContext }) {
  const { field, sim, point, profile } = ctx;
  const [data, setData] = useState<FieldConditionsResponse | null>(null);
  const [assessment, setAssessment] = useState<ConditionAssessment | null>(null);
  const [loading, setLoading] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestKey = JSON.stringify(conditionRequest(ctx));
  const request = useMemo(() => JSON.parse(requestKey), [requestKey]);

  useEffect(() => {
    if (!point || ctx.active === false) return;
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 180_000);
    let current = true;
    setData(null); setAssessment(null); setLoading(true); setAssessing(false); setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const result = await ctx.api.client.inputs.conditions(request, abort.signal);
        if (!current) return;
        setData(result); setAssessment(result.assessment); setLoading(false);
        if (result.can_assess !== false && request.readings.some((r: { kind: string }) => r.kind !== "note") && request.crops.length) {
          setAssessing(true);
          try {
            const checked = await ctx.api.client.inputs.assessConditions(request, abort.signal);
            if (current) {
              setAssessment(checked.assessment);
              if (field) updateSimField(field.field_id, { conditionAssessment: { inputsKey: requestKey, assessment: checked.assessment } });
            }
          } catch (e) {
            if (current) setError(e instanceof Error ? e.message : "Crop impacts could not be assessed. Your readings are saved.");
          } finally { if (current) setAssessing(false); }
        }
      } catch (e) {
        if (current) setError(e instanceof Error ? e.message : "Local estimates could not be loaded. Your readings are saved.");
      } finally { if (current) setLoading(false); window.clearTimeout(timeout); }
    }, 300);
    return () => { current = false; abort.abort(); window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [request, field?.field_id, ctx.api.client, ctx.active, retry]);

  if (!field) return null;
  const reset = (key: string) => {
    const readings = sim.readings.filter(r => (r.kind === "custom" ? `custom:${r.name?.trim().toLowerCase()}:${r.unit?.trim().toLowerCase()}` : r.kind) !== key);
    updateSimField(field.field_id, { readings });
    farmActions.updateField(field.field_id, { readings: readings.map(({ depthCm, ...r }) => ({ ...r, depth_cm: depthCm })) });
  };
  return <div className="fc-columns">
    <div className="fc-column" aria-label="Regional conditions">
      <section className="db-card fc-baselines">
        <div className="db-card-head"><h2>Regional conditions</h2></div>
        <p className="dash-muted">Local dataset estimates fill conditions you leave blank. Your measurements take precedence.</p>
        {loading ? <p role="status">Loading local baselines…</p> : null}
        <dl className="fc-values">{data?.values.filter(v => v.kind !== "custom").map(v => <div key={v.key}>
          <dt>{unitLabel(v.label)}{v.kind === "soil_moisture_pct" ? <small>NASA baseline: surface saturation</small> : null}</dt>
          <dd>{v.baseline?.value == null ? "Not available" : (qtyText(v.baseline.value, v.unit) ?? "Not available")}<small>{v.baseline?.source ? <a href={v.baseline.source.url} target="_blank" rel="noreferrer">{v.baseline.source.title}</a> : "No supported local estimate"}</small>{v.baseline ? <small>{v.baseline.note}</small> : null}</dd>
        </div>)}</dl>
      </section>
      {profile ? <ResearchPanel profile={profile} field={field} /> : <p className="dash-muted">Loading regional guidance…</p>}
    </div>
    <div className="fc-column" aria-label="Personal field conditions">
      <section className="db-card fc-effective">
        <div className="db-card-head"><h2>Conditions used for your field</h2></div>
        <p className="dash-muted">The latest dated measurement is used for each condition. Clear your entries to return to the baseline.</p>
        <dl className="fc-values">{data?.values.filter(v => v.value !== null).map(v => <div key={v.key}>
          <dt>{unitLabel(v.label)}<small>{v.origin === "grower" ? `You entered · ${v.date}${v.depth_cm != null ? ` · ${v.depth_cm} cm depth` : ""}` : "Local baseline"}{v.moisture_basis ? ` · ${v.moisture_basis.replace(/_/g, " ")}` : ""}</small></dt>
          <dd><strong>{qtyText(v.value, v.unit)}</strong>{v.origin === "grower" ? <button type="button" className="btn btn-small btn-quiet" onClick={() => reset(v.key)} aria-label={`Use baseline for ${v.label}`}>Use baseline</button> : null}</dd>
        </div>)}</dl>
        {data && !data.values.some(v => v.value !== null) ? <p>No local values available. Add your measurements below.</p> : null}
        <p className="fc-scope">Weather readings replace estimates on matching recorded dates. Soil pH, temperature and other conditions inform the crop assessment below.</p>
      </section>
      <ReadingsLog ctx={ctx} />
      <section className="db-card fc-impacts" aria-label="Crop condition assessment" aria-busy={assessing}>
        <div className="db-card-head"><h2>What this means for your crops</h2></div>
        {assessing ? <p role="status">AI is checking published crop ranges and growth effects…</p> : null}
        {!request.crops.length ? <p>Pick your crops in step 2 to see what these readings mean for them.</p> : null}
        {assessment?.reason_text && !assessing ? <p className="dash-muted">{assessment.reason_text}</p> : null}
        {assessment?.impacts.map((impact, i) => <article key={`${impact.key}-${impact.crop_id}-${i}`} className="fc-impact" data-rating={impact.rating}>
          <div className="fc-impact-head"><h3>{cropLabel(impact.crop_id)} · {unitLabel(data?.values.find(v => v.key === impact.key)?.label ?? impact.key)}</h3><span className={`fc-rating fc-rating-${impact.rating}`}>{impact.rating === "normal" ? "Normal" : impact.rating === "abnormal" ? "Outside normal range" : "Not assessed"}</span></div>
          {impact.normal_min !== null && impact.normal_max !== null ? <p className="fc-range">Published range: {impact.normal_min}–{impact.normal_max} {impact.unit}</p> : null}
          <p>{impact.effect}</p>{impact.context ? <p className="dash-muted">{impact.context}</p> : null}
          {impact.source ? <a href={impact.source.url} target="_blank" rel="noreferrer">{impact.source.title} · AI-found, quote checked</a> : null}
        </article>)}
        {assessment ? <p className="fc-scope">{assessment.note}</p> : <p className="dash-muted">Add a measurement to check how it relates to your crops. Missing evidence stays unassessed.</p>}
        {error ? <div role="alert"><p>{error}</p><button type="button" className="btn btn-secondary" onClick={() => setRetry(n => n + 1)}>Retry assessment</button></div> : null}
      </section>
    </div>
  </div>;
}

export function FieldConditionNotice({ ctx, onOpen }: { ctx: StepContext; onOpen: () => void }) {
  const saved = ctx.sim.conditionAssessment;
  if (!saved || saved.inputsKey !== JSON.stringify(conditionRequest(ctx))) return null;
  const risks = saved.assessment.impacts.filter(i => i.rating === "abnormal");
  if (!risks.length) return null;
  return <section className="db-card fc-overview-warning" aria-label="Field conditions affecting these crops">
    <div className="db-card-head"><h3>Field conditions to account for</h3></div>
    <ul>{risks.map((risk, i) => <li key={`${risk.key}-${risk.crop_id}-${i}`}>
      <strong>{cropLabel(risk.crop_id)} · {risk.key.replace(/_/g, " ")}</strong>: {risk.effect}
      {risk.context ? <span className="dash-muted"> {risk.context}</span> : null}
      {risk.source ? <> <a href={risk.source.url} target="_blank" rel="noreferrer">Source</a></> : null}
    </li>)}</ul>
    <p className="fc-scope">These crop-growth concerns are assessed separately from the weather replay. No numerical yield or margin penalty is assumed.</p>
    <button type="button" className="btn btn-secondary" onClick={onOpen}>See your readings</button>
  </section>;
}
