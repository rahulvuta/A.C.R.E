import { useEffect, useMemo } from "react";
import { areaM2, bbox, parcels } from "../../farm/geometry";
import { farmActions } from "../../farm/hooks";
import type { Farm, Field, FieldGeometry } from "../../farm/types";
import { planSchema, ThisSeason, type Plan } from "../../planning";
import { fieldPoint, useFieldPlace } from "../../state/useFieldPlace";
import type { GlobalApi } from "../../state/useGlobal";
import { baselineOf, BASELINE_ID, hasSimField, removeSimField, updateSimField, useSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { areaText, suggestUnits, useUnits } from "../../ui/units";
import type { StepContext } from "../guided/context";
import { cropsOf } from "../guided/context";
import { cropLabel } from "../guided/format";
import { nextStep, stepsDone } from "../guided/progress";
import { STEPS, type StepId } from "../guided/steps";
import { FieldConditions } from "./FieldConditions";

/*
  One field's page is one summary (card 13): the field's outline, its plan in one line, where
  the grower is in the six steps, the next jobs, and readings. Each part has one button back
  into the step that owns it. The six steps are the only place a plan is edited, run or
  compared, so nothing exists twice.
*/
const stepHref = (id: StepId, part?: string) => `?view=app#u=${id}${part ? `&p=${part}` : ""}`;

/** The field's outline as a small picture, drawn from its own boundary. */
export function FieldShape({ geometry, label }: { geometry: FieldGeometry; label: string }) {
  const [w, s, e, n] = bbox(geometry);
  const W = 160, H = 120, pad = 12;
  // Longitude shrinks with latitude, so the shape keeps its real proportions.
  const kx = Math.cos((((s + n) / 2) * Math.PI) / 180) || 1;
  const spanX = Math.max((e - w) * kx, 1e-9), spanY = Math.max(n - s, 1e-9);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const ox = (W - spanX * scale) / 2, oy = (H - spanY * scale) / 2;
  const d = parcels(geometry)
    .flatMap((poly) => poly)
    .map((ring) => ring.map(([x, y], i) => `${i ? "L" : "M"}${(ox + (x! - w) * kx * scale).toFixed(1)} ${(oy + (n - y!) * scale).toFixed(1)}`).join("") + "Z")
    .join("");
  return (
    <svg className="fs-shape" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <rect width={W} height={H} rx="10" className="fs-shape-ground" />
      <path d={d} fillRule="evenodd" className="fs-shape-field" />
    </svg>
  );
}

export function FieldWorkspace({ api, farm, field, onClose, onCopy }: { api: GlobalApi; farm: Farm; field: Field; tab?: string; onTab?: (t: string) => void; onClose: () => void; onCopy: () => void; onOpenField?: (id: string) => void }) {
  const sim = useSimField(field.field_id);
  const units = useUnits();
  const place = useFieldPlace(api.client, field);
  const profile = place?.profile.state === "ready" ? place.profile.data : null;
  const info = place?.place.state === "ready" ? place.place.data : null;
  const regionKey = profile?.regionKey ?? info?.regionKeys[0] ?? null;
  // The field being looked at sets the units from its country, until the grower chooses their own.
  const country = info?.country ?? null;
  useEffect(() => suggestUnits(country), [country]);
  const point = useMemo(() => fieldPoint(field), [field]);

  // A field this browser has not simulated yet starts from what the field itself carries.
  useEffect(() => {
    if (hasSimField(field.field_id)) return;
    updateSimField(field.field_id, {
      rotation: field.plan ? [field.plan] : [],
      equipment: field.equipment ?? [],
      readings: (field.readings ?? []).map(({ depth_cm, ...r }) => ({ ...r, depthCm: depth_cm ?? null })),
    });
  }, [field]);

  const ctx: StepContext = { api, farm, field, sim, point, regionKey, profile, go: (s) => window.location.assign(stepHref(s)) };
  const area = areaText(areaM2(field.geometry), units);
  const where = info ? [info.admin2Name, info.admin1Name, info.countryName].filter(Boolean).join(", ") : "";
  const crops = cropsOf(sim.rotation).map(cropLabel).join(" → ");
  const done = stepsDone(sim);
  const next = STEPS.find((s) => s.id === nextStep(sim))!;
  const reachable = (id: StepId) => id === "farm" || id === "now" || done.now;
  // The next jobs come from the plan the grower chose, or from what they do now.
  const chosen = sim.chosenId && sim.chosenId !== BASELINE_ID ? (sim.scenarios.find((s) => s.scenarioId === sim.chosenId) ?? baselineOf(sim)) : baselineOf(sim);
  const plans = chosen.rotation.map((p) => planSchema.safeParse(p)).flatMap((r) => (r.success ? [r.data as Plan] : []));
  const seePlan = (
    <a className="btn btn-secondary" href={stepHref("plan")}>
      See the whole plan
    </a>
  );

  return (
    <section className="fw fs" aria-label={`Field ${field.name}`}>
      {farm.demo ? (
        <Banner kind="synthetic">
          <strong>Demo farm.</strong> Example values, kept apart from your own fields.{" "}
          <button type="button" className="btn btn-quiet" onClick={onCopy}>Copy this field to my fields</button>
        </Banner>
      ) : null}

      <section className="db-card fs-top" aria-label="Field details">
        <FieldShape geometry={field.geometry} label={`Outline of ${field.name}`} />
        <div className="fs-facts">
          <input className="input fw-strip-name" aria-label="Field name" defaultValue={field.name} onBlur={(e) => farmActions.updateField(field.field_id, { name: e.target.value })} />
          <p className="fs-line">
            <strong>{area.main}</strong> <span className="dash-muted">({area.other})</span>
            {field.approx_shape ? <span className="mp-approx">Approximate shape</span> : null}
            {where ? <span className="dash-muted" translate="no"> · {where}</span> : null}
          </p>
          <p className="fs-line">
            <span className="dash-muted">What you grow: </span>
            {crops || "Not set yet"}
          </p>
        </div>
        <div className="fs-actions">
          <a className="btn btn-secondary" href={stepHref("now", "crops")}>
            Change crops and dates
          </a>
          <button type="button" className="btn btn-quiet" onClick={() => { if (window.confirm(`Delete ${field.name}? This removes its boundary and settings from this browser.`)) { removeSimField(field.field_id); farmActions.deleteField(field.field_id); onClose(); } }}>
            Delete field
          </button>
        </div>
      </section>

      <section className="db-card fs-steps" aria-label="Where you are in the six steps">
        <div className="db-card-head">
          <h2>
            Step {next.n} of {STEPS.length}
          </h2>
          <a className="btn btn-primary" href={stepHref(next.id)}>
            {next.id === "plan" ? "See your plan" : `Continue: ${next.nav}`}
          </a>
        </div>
        <ol className="fs-step-list">
          {STEPS.map((s) => {
            const state = done[s.id] ? "done" : s.id === next.id ? "now" : "todo";
            const body = (
              <>
                <span className="fs-step-dot" aria-hidden="true">
                  {done[s.id] ? "✓" : s.n}
                </span>
                <span>{s.nav}</span>
                <span className="sr-only">{done[s.id] ? " (done)" : s.id === next.id ? " (next)" : ""}</span>
              </>
            );
            return (
              <li key={s.id} data-state={state}>
                {reachable(s.id) ? <a href={stepHref(s.id)}>{body}</a> : <span className="fs-step-off">{body}</span>}
              </li>
            );
          })}
        </ol>
      </section>

      {api.source === "live" && point && plans.length && done.now ? <ThisSeason location={point} plans={plans} startSeason={sim.startSeason} action={seePlan} /> : null}

      <section className="fs-readings" aria-label="Readings and local conditions">
        <h2 className="fs-heading">Readings and local conditions</h2>
        <FieldConditions ctx={ctx} />
      </section>
    </section>
  );
}
