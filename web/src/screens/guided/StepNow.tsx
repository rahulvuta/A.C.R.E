import { useRef } from "react";
import { MAX_ROTATION_LEGS } from "../../api/limits";
import type { Origin } from "../../api/model";
import { areaHa } from "../../farm/geometry";
import { farmActions } from "../../farm/hooks";
import type { FieldPlan } from "../../farm/types";
import { EconomicsEditor, EquipmentEditor, PlanEditor, dateFields, getPlanDate, type PlanEditorValue } from "../../inputs";
import { MAX_ZONES, evenShares, newZoneId, setZoneLayout, updateSimField, type SimZone } from "../../state/simField";
import { baselineReady, cropsOf, planReady, simCrops, zonesOk, type StepContext } from "./context";
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
  const zones = sim.zones ?? [];
  if (part === "crops") return zones.length ? zonesOk(zones) && zones.every((z) => cropsChosen(sim.zoneRotations?.[z.zoneId] ?? [])) : cropsChosen(sim.rotation);
  if (part === "dates") return baselineReady(sim);
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
    {show !== "dates" ? <p className="gf-muted">{show === "crops" ? "One season is one main crop, what covers the field over winter, and the next main crop. Add a season if your rotation is longer. " : ""}This rotation repeats through the 10-year outlook.</p> : null}
  </div>;
}
/** The field split into zones, each with its own current rotation. The simulation runs the whole field: zones are added together. */
function ZonesRotation({ ctx, show }: { ctx: StepContext; show: "all" | "crops" | "dates" }) {
  const { field, sim } = ctx;
  const zones = sim.zones ?? [];
  const rotations = sim.zoneRotations ?? {};
  const edit = !(show === "dates");
  const total = zones.reduce((a, z) => a + z.share, 0);
  const pct = (z: SimZone) => Math.round(z.share * 1000) / 10;
  const layout = (nextZones: SimZone[], nextRot: Record<string, FieldPlan[]>) => setZoneLayout(field!.field_id, nextZones, nextRot);
  const rename = (id: string, name: string) => layout(zones.map((z) => (z.zoneId === id ? { ...z, name } : z)), rotations);
  const setShare = (id: string, percent: number) => layout(zones.map((z) => (z.zoneId === id ? { ...z, share: Math.min(1, Math.max(0, percent / 100)) } : z)), rotations);
  const even = () => { const e = evenShares(zones.length); layout(zones.map((z, i) => ({ ...z, share: e[i]! })), rotations); };
  const add = () => {
    const id = newZoneId();
    const e = evenShares(zones.length + 1);
    layout([...zones.map((z, i) => ({ ...z, share: e[i]! })), { zoneId: id, name: `Zone ${zones.length + 1}`, share: e[zones.length]! }], { ...rotations, [id]: structuredClone(sim.rotation) });
  };
  const remove = (id: string) => {
    const left = zones.filter((z) => z.zoneId !== id);
    const { [id]: _gone, ...restRot } = rotations;
    const e = evenShares(Math.max(left.length, 1));
    layout(left.map((z, i) => ({ ...z, share: e[i]! })), restRot);
  };
  return <div className="gf-zones">
    {edit ? <p className="gf-muted">Each zone is a part of this field with its own crops. The simulation runs the whole field: money adds up across zones, and every zone sees the same weather.</p> : null}
    {zones.map((z) => <section key={z.zoneId} className="db-card gf-zone" aria-label={`Zone ${z.name}`}>
      <div className="db-card-head">
        {edit ? <>
          <label className="gf-zone-name">Zone name <input type="text" value={z.name} maxLength={120} onChange={(e) => rename(z.zoneId, e.target.value)} /></label>
          <label className="gf-zone-share">Share of field (%) <input type="number" min={1} max={100} step={0.5} value={pct(z)} onChange={(e) => setShare(z.zoneId, Number(e.target.value))} /></label>
          <button type="button" className="btn btn-quiet" onClick={() => remove(z.zoneId)}>Remove zone</button>
        </> : <h3>{z.name} · {pct(z)}% of the field</h3>}
      </div>
      <RotationEditor ctx={ctx} idPrefix={`z_${z.zoneId}`} show={show} rotation={rotations[z.zoneId] ?? []} onChange={(r) => layout(zones, { ...rotations, [z.zoneId]: r })} />
    </section>)}
    {edit ? <div className="gf-zone-actions">
      {zones.length < MAX_ZONES ? <button type="button" className="btn btn-secondary" onClick={add}>Add a zone</button> : null}
      <button type="button" className="btn btn-quiet" onClick={even}>Make the shares equal</button>
      <button type="button" className="btn btn-quiet" onClick={() => layout([], { [zones[0]!.zoneId]: sim.rotation })}>Back to one plan for the whole field</button>
      <span className={zonesOk(zones) ? "gf-ok" : "gf-error"} role={zonesOk(zones) ? undefined : "alert"}>{zonesOk(zones) ? "Shares add up to 100%" : `Shares add up to ${Math.round(total * 1000) / 10}%; they need to add up to 100%.`}</span>
    </div> : null}
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
  const ready = baselineReady(sim) && economicsReady(sim);
  const zoned = (sim.zones ?? []).length > 0;
  const splitIntoZones = () => {
    const a = newZoneId(), b = newZoneId();
    setZoneLayout(field.field_id, [{ zoneId: a, name: "Zone 1", share: 0.5 }, { zoneId: b, name: "Zone 2", share: 0.5 }], { [a]: structuredClone(sim.rotation), [b]: structuredClone(sim.rotation) });
  };
  return <div className="gf-now">
    {single ? <div className="gf-part-head">
      <p className="gf-kicker">Part {NOW_PARTS.findIndex((p) => p.id === part) + 1} of {NOW_PARTS.length}</p>
      <h3 className="gf-part-question">{single.question}</h3>
      <span className={ready ? "gf-ok" : "gf-muted"}>{ready ? "Ready to simulate" : "Not complete yet"}</span>
    </div> : null}
    {showRotation ? zoned ? <ZonesRotation ctx={ctx} show={rotationShow} />
      : single ? <section className="db-card" aria-label={`Current plan for ${field.name}`}><RotationEditor ctx={ctx} rotation={sim.rotation} onChange={setRotation} show={rotationShow} />
        {rotationShow !== "dates" ? <button type="button" className="btn btn-secondary" onClick={splitIntoZones}>Split this field into zones</button> : null}</section>
      : <section className="db-card" aria-label={`Current plan for ${field.name}`}>
      <div className="db-card-head"><h2>Current plan for {field.name}</h2><span className={ready ? "gf-ok" : "gf-muted"}>{ready ? "Ready to simulate" : "Not complete yet"}</span></div>
      <RotationEditor ctx={ctx} rotation={sim.rotation} onChange={setRotation} />
      <button type="button" className="btn btn-secondary" onClick={splitIntoZones}>Split this field into zones</button>
    </section> : null}
    {showEquipment ? <EquipmentEditor api={ctx.api.client.inputs} value={sim.equipment} onChange={equipment => { updateSimField(field.field_id, { equipment }); farmActions.updateField(field.field_id, { equipment }); }} /> : null}
    {showMoney ? <><EconomicsEditor show={economicsShow} location={point} area={{ value: areaHa(field.geometry) || null, unit: "ha" }} crops={simCrops(sim)} api={ctx.api.client.inputs} value={economicsValue(sim)} onChange={value => updateSimField(field.field_id, { economicsInputs: value, overrides: simulationOverrides(value), loss: { ...sim.loss, drySpringPct: value.loss_assumptions.dry_spring_pct, heavyRainPct: value.loss_assumptions.heavy_rain_pct } })} />
    {economicsShow !== "losses" ? <p className="gf-muted">A price you change needs all three cases (low, typical, high) in the same unit. A cost list you enter replaces the regional costs, so include every cost.</p> : null}
    {economicsShow !== "losses" && !economicsReady(sim) ? <p role="alert" className="gf-error">Finish or reset incomplete money entries before continuing. Enter all three price cases in the same unit, and a value and unit for each cost.</p> : null}</> : null}
  </div>;
}
