import { MAX_ROTATION_LEGS } from "../../api/limits";
import type { Origin } from "../../api/model";
import { areaHa } from "../../farm/geometry";
import { farmActions } from "../../farm/hooks";
import type { FieldPlan } from "../../farm/types";
import { EconomicsEditor, EquipmentEditor, PlanEditor, dateFields, getPlanDate, type PlanEditorValue } from "../../inputs";
import { updateSimField } from "../../state/simField";
import { cropsOf, planReady, rotationReady, type StepContext } from "./context";
import { cropLabel } from "./format";
import { economicsReady, economicsValue, simulationOverrides } from "./inputState";

const TRUST: Origin[] = ["grower", "verified_source", "source_checked", "dataset_estimate", "nasa_measured", "nasa_modeled", "calculation", "ai_suggested", "assumed"];
const weakest = (origins: Origin[]): Origin => origins.reduce<Origin>((w, o) => TRUST.indexOf(o) > TRUST.indexOf(w) ? o : w, "grower");
export const emptySeason = (i: number, previous = "", taken: string[] = []): FieldPlan => {
  // Plan ids must be unique within a rotation, also after a middle season was removed.
  let n = i + 1;
  while (taken.includes(`season_${n}`)) n += 1;
  return { plan_id: `season_${n}`, label: `Season ${i + 1}`, previous_crop_id: previous, prev_harvest: "", winter: { kind: "none" }, next_crop_id: "", next_plant: "" };
};

/** Saved editor inputs (dates with their origin, crop details) are keyed per rotation: the current plan keeps the plain plan id,
 *  every alternative its own prefix, so two rotations that both have a "season_1" never share dates or provenance. */
export const planInputKey = (idPrefix: string, planId: string) => (idPrefix === "rot" ? planId : `${idPrefix}/${planId}`);

function editorValue(ctx: StepContext, plan: FieldPlan, idPrefix: string): PlanEditorValue {
  const saved = ctx.sim.planInputs?.[planInputKey(idPrefix, plan.plan_id)];
  const value: PlanEditorValue = {
    plan: { ...plan, previous_crop_id: plan.previous_crop_id || null, next_crop_id: plan.next_crop_id || null, prev_harvest: plan.prev_harvest || null, next_plant: plan.next_plant || null },
    dates: [],
    cropDetails: saved?.cropDetails ?? cropsOf([plan]).map(id => ({ crop_id: id, name: cropLabel(id), family: null, roles: [], origin: plan.origins?.crops ?? "grower" })),
  };
  value.dates = saved?.dates ?? dateFields.flatMap(field => { const date = getPlanDate(value.plan, field); return date ? [{ field, value: date, origin: plan.origins?.dates ?? "assumed" }] : []; });
  return value;
}
function fieldPlan(original: FieldPlan, value: PlanEditorValue): FieldPlan {
  const p = value.plan;
  const dates = value.dates.flatMap(d => d.value && d.origin ? [d.origin] : []);
  return {
    ...original, previous_crop_id: p.previous_crop_id ?? "", prev_harvest: p.prev_harvest ?? "", next_crop_id: p.next_crop_id ?? "", next_plant: p.next_plant ?? "",
    winter: p.winter.kind === "none" ? { kind: "none" } : p.winter.kind === "cover" ? { kind: "cover", crop_id: p.winter.crop_id ?? "", seed: p.winter.seed ?? "", terminate: p.winter.terminate ?? "" } : { kind: "winter_grain", crop_id: p.winter.crop_id ?? "", plant: p.winter.plant ?? "", harvest: p.winter.harvest ?? "" },
    origins: { ...original.origins, ...(dates.length ? { dates: weakest(dates) } : {}), crops: weakest(value.cropDetails.map(c => c.origin)) },
  };
}
export function RotationEditor({ ctx, rotation, onChange, idPrefix = "rot" }: { ctx: StepContext; rotation: FieldPlan[]; onChange: (r: FieldPlan[]) => void; idPrefix?: string }) {
  if (!ctx.point || !ctx.field) return null;
  const seasons = rotation.length ? rotation : [emptySeason(0)];
  return <div className="gf-rotation">
    {seasons.map((plan, i) => <section key={`${idPrefix}-${i}`} className="gf-season" aria-label={`Season ${i + 1}`}>
      <div className="gf-season-head"><h3>Season {i + 1}</h3>{seasons.length > 1 ? <button type="button" className="btn btn-quiet" onClick={() => { updateSimField(ctx.field!.field_id, (current) => { const { [planInputKey(idPrefix, plan.plan_id)]: _gone, ...planInputs } = current.planInputs ?? {}; return { planInputs }; }); onChange(seasons.filter((_, j) => j !== i)); }}>Remove season</button> : null}</div>
      <PlanEditor location={ctx.point!} regionKey={ctx.regionKey ?? ""} api={ctx.api.client.inputs} value={editorValue(ctx, plan, idPrefix)} onChange={value => {
        updateSimField(ctx.field!.field_id, current => ({ planInputs: { ...current.planInputs, [planInputKey(idPrefix, plan.plan_id)]: { dates: value.dates, cropDetails: value.cropDetails } } }));
        onChange(seasons.map((p, j) => j === i ? fieldPlan(plan, value) : p));
      }} />
    </section>)}
    {seasons.length < MAX_ROTATION_LEGS ? <button type="button" className="btn btn-secondary" onClick={() => onChange([...seasons, emptySeason(seasons.length, seasons.at(-1)?.next_crop_id, seasons.map((p) => p.plan_id))])}>Add a season</button> : null}
    <p className="gf-muted">This rotation repeats through the 10-year historical replay.</p>
  </div>;
}
export function StepNow({ ctx, part = "all" }: { ctx: StepContext; part?: "all" | "rotation" | "money" }) {
  const { field, sim, point } = ctx;
  if (!field || !point) return null;
  const setRotation = (rotation: FieldPlan[]) => {
    updateSimField(field.field_id, { rotation });
    if (rotation[0] && planReady(rotation[0])) farmActions.setFieldPlan(field.field_id, rotation[0]);
  };
  const rotation = part !== "money";
  const money = part !== "rotation";
  return <div className="gf-now">
    {rotation ? <section className="db-card" aria-label={`Current plan for ${field.name}`}>
      <div className="db-card-head"><h2>Current plan for {field.name}</h2><span className={rotationReady(sim.rotation) && economicsReady(sim) ? "gf-ok" : "gf-muted"}>{rotationReady(sim.rotation) && economicsReady(sim) ? "Ready to simulate" : "Not complete yet"}</span></div>
      <RotationEditor ctx={ctx} rotation={sim.rotation} onChange={setRotation} />
    </section> : null}
    {rotation ? <EquipmentEditor api={ctx.api.client.inputs} value={sim.equipment} onChange={equipment => { updateSimField(field.field_id, { equipment }); farmActions.updateField(field.field_id, { equipment }); }} /> : null}
    {money ? <><EconomicsEditor location={point} area={{ value: areaHa(field.geometry) || null, unit: "ha" }} crops={cropsOf(sim.rotation)} api={ctx.api.client.inputs} value={economicsValue(sim)} onChange={value => updateSimField(field.field_id, { economicsInputs: value, overrides: simulationOverrides(value), loss: { ...sim.loss, drySpringPct: value.loss_assumptions.dry_spring_pct, heavyRainPct: value.loss_assumptions.heavy_rain_pct } })} />
    <p className="gf-muted">A price override needs all three cases in the same unit. An entered cost list replaces regional costs; include every cost in your list.</p>
    {!economicsReady(sim) ? <p role="alert" className="gf-error">Finish or reset incomplete money entries before continuing. Enter all three price cases in the same unit, and a value and unit for each cost.</p> : null}</> : null}
  </div>;
}
