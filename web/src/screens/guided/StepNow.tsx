import { useRef } from "react";
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
/** The parts of step 2, asked one at a time. */
export const NOW_PARTS = [
  { id: "crops", nav: "Crops", question: "Which crops are in your rotation?" },
  { id: "dates", nav: "Dates", question: "When do you plant and harvest?" },
  { id: "equipment", nav: "Equipment", question: "Which equipment can you use?" },
  { id: "prices", nav: "Prices and costs", question: "Do these prices, yields and costs look right?" },
  { id: "losses", nav: "Weather losses", question: "How much do you lose in a bad year?" },
] as const;
export type NowPart = (typeof NOW_PARTS)[number]["id"];
/** Every season has its crops picked (dates come in the next part). */
export const cropsChosen = (r: FieldPlan[]) => r.length > 0 && r.every((p) => Boolean(p.previous_crop_id && p.next_crop_id && (p.winter.kind === "none" || p.winter.crop_id)));
export function nowPartReady(part: NowPart, sim: StepContext["sim"]): boolean {
  if (part === "crops") return cropsChosen(sim.rotation);
  if (part === "dates") return rotationReady(sim.rotation);
  if (part === "prices") return economicsReady(sim);
  return true;
}

export function RotationEditor({ ctx, rotation, onChange, idPrefix = "rot", show = "all" }: { ctx: StepContext; rotation: FieldPlan[]; onChange: (r: FieldPlan[]) => void; idPrefix?: string; show?: "all" | "crops" | "dates" }) {
  const seasons = rotation.length ? rotation : [emptySeason(0)];
  // Several seasons can fill their dates at the same time; each change builds on the latest rotation, not on the one it rendered with.
  const latest = useRef(seasons);
  latest.current = seasons;
  if (!ctx.point || !ctx.field) return null;
  const many = seasons.length > 1;
  return <div className="gf-rotation">
    {seasons.map((plan, i) => <section key={`${idPrefix}-${i}`} className="gf-season" aria-label={`Season ${i + 1}`}>
      {many || show !== "dates" ? <div className="gf-season-head"><h3>Season {i + 1}</h3>{many && show !== "dates" ? <button type="button" className="btn btn-quiet" onClick={() => { updateSimField(ctx.field!.field_id, (current) => { const { [planInputKey(idPrefix, plan.plan_id)]: _gone, ...planInputs } = current.planInputs ?? {}; return { planInputs }; }); onChange(seasons.filter((_, j) => j !== i)); }}>Remove season</button> : null}</div> : null}
      <PlanEditor show={show} location={ctx.point!} regionKey={ctx.regionKey ?? ""} api={ctx.api.client.inputs} value={editorValue(ctx, plan, idPrefix)} onChange={value => {
        updateSimField(ctx.field!.field_id, current => ({ planInputs: { ...current.planInputs, [planInputKey(idPrefix, plan.plan_id)]: { dates: value.dates, cropDetails: value.cropDetails } } }));
        const next = latest.current.map((p, j) => j === i ? fieldPlan(p, value) : p);
        latest.current = next;
        onChange(next);
      }} />
    </section>)}
    {show !== "dates" && seasons.length < MAX_ROTATION_LEGS ? <button type="button" className="btn btn-secondary" onClick={() => onChange([...seasons, emptySeason(seasons.length, seasons.at(-1)?.next_crop_id, seasons.map((p) => p.plan_id))])}>Add a season</button> : null}
    {show !== "dates" ? <p className="gf-muted">{show === "crops" ? "One season is one main crop, what covers the field over winter, and the next main crop. Add a season if your rotation is longer. " : ""}This rotation repeats through the 10-year historical replay.</p> : null}
  </div>;
}
type Part = "all" | "rotation" | "money" | NowPart;
export function StepNow({ ctx, part = "all" }: { ctx: StepContext; part?: Part }) {
  const { field, sim, point } = ctx;
  if (!field || !point) return null;
  const setRotation = (rotation: FieldPlan[]) => {
    updateSimField(field.field_id, { rotation });
    if (rotation[0] && planReady(rotation[0])) farmActions.setFieldPlan(field.field_id, rotation[0]);
  };
  const has = (...p: Part[]) => p.includes(part);
  const rotationShow = has("crops") ? "crops" : has("dates") ? "dates" : "all";
  const showRotation = has("all", "rotation", "crops", "dates");
  const showEquipment = has("all", "rotation", "equipment");
  const economicsShow = has("prices") ? "prices" : has("losses") ? "losses" : "all";
  const showMoney = has("all", "money", "prices", "losses");
  const single = NOW_PARTS.find((p) => p.id === part);
  const ready = rotationReady(sim.rotation) && economicsReady(sim);
  return <div className="gf-now">
    {single ? <div className="gf-part-head">
      <p className="gf-kicker">Part {NOW_PARTS.findIndex((p) => p.id === part) + 1} of {NOW_PARTS.length}</p>
      <h3 className="gf-part-question">{single.question}</h3>
      <span className={ready ? "gf-ok" : "gf-muted"}>{ready ? "Ready to simulate" : "Not complete yet"}</span>
    </div> : null}
    {showRotation ? single ? <section className="db-card" aria-label={`Current plan for ${field.name}`}><RotationEditor ctx={ctx} rotation={sim.rotation} onChange={setRotation} show={rotationShow} /></section>
      : <section className="db-card" aria-label={`Current plan for ${field.name}`}>
      <div className="db-card-head"><h2>Current plan for {field.name}</h2><span className={ready ? "gf-ok" : "gf-muted"}>{ready ? "Ready to simulate" : "Not complete yet"}</span></div>
      <RotationEditor ctx={ctx} rotation={sim.rotation} onChange={setRotation} />
    </section> : null}
    {showEquipment ? <EquipmentEditor api={ctx.api.client.inputs} value={sim.equipment} onChange={equipment => { updateSimField(field.field_id, { equipment }); farmActions.updateField(field.field_id, { equipment }); }} /> : null}
    {showMoney ? <><EconomicsEditor show={economicsShow} location={point} area={{ value: areaHa(field.geometry) || null, unit: "ha" }} crops={cropsOf(sim.rotation)} api={ctx.api.client.inputs} value={economicsValue(sim)} onChange={value => updateSimField(field.field_id, { economicsInputs: value, overrides: simulationOverrides(value), loss: { ...sim.loss, drySpringPct: value.loss_assumptions.dry_spring_pct, heavyRainPct: value.loss_assumptions.heavy_rain_pct } })} />
    {economicsShow !== "losses" ? <p className="gf-muted">A price you change needs all three cases (low, typical, high) in the same unit. A cost list you enter replaces the regional costs, so include every cost.</p> : null}
    {economicsShow !== "losses" && !economicsReady(sim) ? <p role="alert" className="gf-error">Finish or reset incomplete money entries before continuing. Enter all three price cases in the same unit, and a value and unit for each cost.</p> : null}</> : null}
  </div>;
}
