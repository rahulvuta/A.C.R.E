import { useEffect, useMemo, useState } from "react";
import type { Origin, SourceRef } from "../../api/model";
import { EQUIPMENT, type CropOverride, type Economics } from "../../api/simModel";
import { farmActions } from "../../farm/hooks";
import type { FieldPlan } from "../../farm/types";
import { updateSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { OriginBadge } from "../../ui/OriginBadge";
import { cropsOf, planReady, rotationReady, type StepContext } from "./context";
import { cropLabel, money, NA, num } from "./format";
import { pick, useInputsModule } from "./slots";

/*
  Step 2, "What you do now": the field's current rotation (1–4 seasons, repeated), typical
  dates from POST /v1/plans/autofill, equipment, and prices / yields / costs with their
  sourced defaults (POST /v1/economics/estimate). The U3 input components mount here when
  merged; until then these are D's own editors over the same state.
*/

const TRUST: Origin[] = ["grower", "verified_source", "source_checked", "dataset_estimate", "nasa_measured", "nasa_modeled", "calculation", "ai_suggested", "assumed"];
/** The least certain origin among several dates (a set of dates is only as sure as its weakest). */
const weakest = (os: Origin[]): Origin => os.reduce<Origin>((w, o) => (TRUST.indexOf(o) > TRUST.indexOf(w) ? o : w), "grower");

export const emptySeason = (i: number, previous = ""): FieldPlan => ({
  plan_id: `season_${i + 1}`,
  label: `Season ${i + 1}`,
  previous_crop_id: previous,
  prev_harvest: "",
  winter: { kind: "none" },
  next_crop_id: "",
  next_plant: "",
});

type Opt = { id: string; name: string };
function CropChoice({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: Opt[]; onChange: (id: string, typed: boolean) => void }) {
  const listed = !value || options.some((o) => o.id === value);
  const [typing, setTyping] = useState(!listed);
  return (
    <div className="pe-row">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={typing ? "__other" : value}
        onChange={(e) => {
          if (e.target.value === "__other") {
            setTyping(true);
            onChange("", true);
          } else {
            setTyping(false);
            onChange(e.target.value, false);
          }
        }}
      >
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        <option value="__other">Type your own crop</option>
      </select>
      {typing ? (
        <input
          aria-label={`${label}: your crop`}
          placeholder="Crop name"
          defaultValue={listed ? "" : cropLabel(value)}
          onChange={(e) => onChange(e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), true)}
        />
      ) : null}
    </div>
  );
}

function DateBox({ id, label, value, origin, onChange }: { id: string; label: string; value: string; origin?: Origin; onChange: (v: string) => void }) {
  const bad = value !== "" && !/^\d{2}-\d{2}$/.test(value);
  return (
    <div className="pe-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} placeholder="MM-DD" inputMode="numeric" aria-invalid={bad || undefined} onChange={(e) => onChange(e.target.value)} />
      {value && origin ? <OriginBadge origin={origin} /> : <span />}
    </div>
  );
}

function SeasonEditor({
  ctx,
  index,
  plan,
  options,
  covers,
  onChange,
  onRemove,
  idPrefix,
}: {
  ctx: StepContext;
  index: number;
  plan: FieldPlan;
  options: Opt[];
  covers: Opt[];
  onChange: (p: FieldPlan) => void;
  onRemove: (() => void) | null;
  idPrefix: string;
}) {
  const [filling, setFilling] = useState<{ state: "idle" } | { state: "loading" } | { state: "done"; sources: Array<{ field: string; value: string | null; origin: Origin; source: SourceRef | null }>; gaps: string[] } | { state: "error"; message: string }>({ state: "idle" });
  const id = (k: string) => `${idPrefix}-${k}-${index}`;
  const set = (patch: Partial<FieldPlan>) => onChange({ ...plan, ...patch });
  const setDate = (patch: Partial<FieldPlan>) => set({ ...patch, origins: { ...plan.origins, dates: "grower" } });
  const setWinter = (w: FieldPlan["winter"], grower = true) => set({ winter: w, origins: { ...plan.origins, ...(grower ? { winter: "grower" as Origin } : {}) } });
  const crop = (k: "previous_crop_id" | "next_crop_id", v: string, typed: boolean) => set({ [k]: v, origins: { ...plan.origins, crops: typed ? "grower" : (plan.origins?.crops ?? "grower") } });

  const fill = async () => {
    if (!ctx.point) return;
    const crops: Array<{ role: "previous" | "cover" | "next"; cropId: string }> = [];
    if (plan.previous_crop_id) crops.push({ role: "previous", cropId: plan.previous_crop_id });
    if (plan.winter.kind !== "none" && plan.winter.crop_id) crops.push({ role: "cover", cropId: plan.winter.crop_id });
    if (plan.next_crop_id) crops.push({ role: "next", cropId: plan.next_crop_id });
    setFilling({ state: "loading" });
    const r = await ctx.api.client.autofill(ctx.point, crops);
    if (!r.ok) return setFilling({ state: "error", message: r.message });
    const got = r.data.plan;
    const dates = r.data.dates.filter((d) => d.value);
    const byField = new Map(dates.map((d) => [d.field, d.value!]));
    const pickDate = (k: string, cur: string) => (cur && plan.origins?.dates === "grower" ? cur : (byField.get(k) ?? (got as Record<string, unknown> | null)?.[k]?.toString() ?? cur));
    const w = plan.winter;
    const gw = got?.winter;
    const winter: FieldPlan["winter"] =
      w.kind === "cover"
        ? { ...w, seed: byField.get("winter.seed") ?? (gw?.kind === "cover" ? gw.seed : "") ?? w.seed, terminate: byField.get("winter.terminate") ?? (gw?.kind === "cover" ? gw.terminate : "") ?? w.terminate }
        : w.kind === "winter_grain"
          ? { ...w, plant: byField.get("winter.plant") ?? (gw?.kind === "winter_grain" ? gw.plant : "") ?? w.plant, harvest: byField.get("winter.harvest") ?? (gw?.kind === "winter_grain" ? gw.harvest : "") ?? w.harvest }
          : w;
    onChange({
      ...plan,
      prev_harvest: pickDate("prev_harvest", plan.prev_harvest),
      next_plant: pickDate("next_plant", plan.next_plant),
      winter,
      origins: { ...plan.origins, dates: dates.length ? weakest(dates.map((d) => d.origin)) : plan.origins?.dates },
    });
    setFilling({ state: "done", sources: dates, gaps: r.data.gaps });
  };

  const dOrigin = plan.origins?.dates;
  return (
    <section className="gf-season" aria-label={`Season ${index + 1}`}>
      <div className="gf-season-head">
        <h3>Season {index + 1}</h3>
        <span className="gf-season-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void fill()} disabled={!plan.previous_crop_id || !plan.next_crop_id || filling.state === "loading"}>
            {filling.state === "loading" ? "Filling…" : "Fill typical dates"}
          </button>
          {onRemove ? (
            <button type="button" className="btn btn-quiet" onClick={onRemove}>
              Remove season
            </button>
          ) : null}
        </span>
      </div>
      <div className="pe-grid gf-season-grid">
        <CropChoice id={id("prev")} label="Crop before" value={plan.previous_crop_id} options={options} onChange={(v, t) => crop("previous_crop_id", v, t)} />
        <DateBox id={id("harv")} label="Its harvest" value={plan.prev_harvest} origin={dOrigin} onChange={(v) => setDate({ prev_harvest: v })} />
        <div className="pe-row">
          <label htmlFor={id("wk")}>Between crops</label>
          <select
            id={id("wk")}
            value={plan.winter.kind}
            onChange={(e) => {
              const k = e.target.value as FieldPlan["winter"]["kind"];
              setWinter(k === "none" ? { kind: "none" } : k === "cover" ? { kind: "cover", crop_id: "", seed: "", terminate: "" } : { kind: "winter_grain", crop_id: "", plant: "", harvest: "" });
            }}
          >
            <option value="none">Nothing planted</option>
            <option value="cover">A cover crop</option>
            <option value="winter_grain">A grain crop</option>
          </select>
          <span />
        </div>
        {plan.winter.kind === "none" ? <span aria-hidden="true" /> : null}
        {plan.winter.kind === "cover" ? (
          <>
            <CropChoice id={id("cov")} label="Cover crop" value={plan.winter.crop_id} options={covers} onChange={(v) => setWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "cover" }>), crop_id: v })} />
            <DateBox id={id("seed")} label="Seed" value={plan.winter.seed} origin={dOrigin} onChange={(v) => set({ winter: { ...(plan.winter as Extract<FieldPlan["winter"], { kind: "cover" }>), seed: v }, origins: { ...plan.origins, dates: "grower" } })} />
            <DateBox id={id("term")} label="End the cover" value={plan.winter.terminate} origin={dOrigin} onChange={(v) => set({ winter: { ...(plan.winter as Extract<FieldPlan["winter"], { kind: "cover" }>), terminate: v }, origins: { ...plan.origins, dates: "grower" } })} />
          </>
        ) : null}
        {plan.winter.kind === "winter_grain" ? (
          <>
            <CropChoice id={id("wg")} label="Grain crop" value={plan.winter.crop_id} options={options} onChange={(v) => setWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "winter_grain" }>), crop_id: v })} />
            <DateBox id={id("wgp")} label="Plant" value={plan.winter.plant} origin={dOrigin} onChange={(v) => set({ winter: { ...(plan.winter as Extract<FieldPlan["winter"], { kind: "winter_grain" }>), plant: v }, origins: { ...plan.origins, dates: "grower" } })} />
            <DateBox id={id("wgh")} label="Harvest" value={plan.winter.harvest} origin={dOrigin} onChange={(v) => set({ winter: { ...(plan.winter as Extract<FieldPlan["winter"], { kind: "winter_grain" }>), harvest: v }, origins: { ...plan.origins, dates: "grower" } })} />
          </>
        ) : null}
        <CropChoice id={id("next")} label="Next crop" value={plan.next_crop_id} options={options} onChange={(v, t) => crop("next_crop_id", v, t)} />
        <DateBox id={id("plant")} label="Its planting" value={plan.next_plant} origin={dOrigin} onChange={(v) => setDate({ next_plant: v })} />
      </div>
      {filling.state === "done" ? (
        <ul className="gf-sources" aria-label="Where the typical dates come from">
          {filling.sources.map((d) => (
            <li key={d.field}>
              <span>
                {d.field.replace("winter.", "").replace(/_/g, " ")}: <strong>{d.value}</strong>
              </span>
              <OriginBadge origin={d.origin} />
              {d.source ? (
                d.source.url ? (
                  <a href={d.source.url} target="_blank" rel="noreferrer">
                    {d.source.title}
                  </a>
                ) : (
                  <span>{d.source.title}</span>
                )
              ) : null}
            </li>
          ))}
          {filling.gaps.map((g) => (
            <li key={g} className="gf-muted">
              {g}
            </li>
          ))}
        </ul>
      ) : filling.state === "error" ? (
        <p className="gf-error" role="alert">
          {filling.message}
        </p>
      ) : null}
      {!planReady(plan) ? <p className="gf-muted">Fill in each crop and date (MM-DD).</p> : null}
    </section>
  );
}

export function RotationEditor({ ctx, rotation, onChange, idPrefix = "rot" }: { ctx: StepContext; rotation: FieldPlan[]; onChange: (r: FieldPlan[]) => void; idPrefix?: string }) {
  const options = useMemo<Opt[]>(() => {
    const seen = new Map<string, string>();
    for (const c of ctx.profile?.crops ?? []) seen.set(c.cropId, c.name);
    for (const p of rotation) for (const c of [p.previous_crop_id, p.next_crop_id]) if (c && !seen.has(c)) seen.set(c, cropLabel(c));
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [ctx.profile, rotation]);
  const covers = useMemo<Opt[]>(() => {
    const seen = new Map<string, string>();
    for (const c of ctx.profile?.covers ?? []) seen.set(c.cropId, c.name);
    for (const p of rotation) if (p.winter.kind !== "none" && p.winter.crop_id && !seen.has(p.winter.crop_id)) seen.set(p.winter.crop_id, cropLabel(p.winter.crop_id));
    return seen.size ? [...seen].map(([id, name]) => ({ id, name })) : options;
  }, [ctx.profile, rotation, options]);
  const seasons = rotation.length ? rotation : [emptySeason(0)];
  return (
    <div className="gf-rotation">
      {seasons.map((p, i) => (
        <SeasonEditor
          key={i}
          ctx={ctx}
          index={i}
          plan={p}
          options={options}
          covers={covers}
          idPrefix={idPrefix}
          onChange={(np) => onChange(seasons.map((x, j) => (j === i ? np : x)))}
          onRemove={seasons.length > 1 ? () => onChange(seasons.filter((_, j) => j !== i)) : null}
        />
      ))}
      {seasons.length < 4 ? (
        <button type="button" className="btn btn-secondary" onClick={() => onChange([...seasons, emptySeason(seasons.length, seasons[seasons.length - 1]?.next_crop_id ?? "")])}>
          Add a season to the rotation
        </button>
      ) : null}
      <p className="gf-muted">The rotation repeats over the 10 years. Each season starts with the crop the season before it ends with.</p>
    </div>
  );
}

function EquipmentEditor({ ctx }: { ctx: StepContext }) {
  const { sim, field } = ctx;
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void ctx.api.client.vocab("equipment").then((r) => {
      if (live && r.ok) setLabels(Object.fromEntries(r.data.map((v) => [v.id, v.label])));
    });
    return () => {
      live = false;
    };
  }, [ctx.api.client]);
  const [other, setOther] = useState("");
  const toggle = (e: string) => updateSimField(field!.field_id, (cur) => ({ equipment: cur.equipment.includes(e) ? cur.equipment.filter((x) => x !== e) : [...cur.equipment, e] }));
  const extras = sim.equipment.filter((e) => e.startsWith("other:"));
  return (
    <section className="db-card" aria-label="Equipment">
      <div className="db-card-head">
        <h2>Equipment you have</h2>
      </div>
      <p className="gf-muted">Plans that need a machine you don't have are flagged, and field passes are costed from published custom rates.</p>
      <div className="gf-chips">
        {EQUIPMENT.map((e) => (
          <label key={e} className="gf-chip">
            <input type="checkbox" checked={sim.equipment.includes(e)} onChange={() => toggle(e)} />
            {labels[e] ?? cropLabel(e)}
          </label>
        ))}
        {extras.map((e) => (
          <label key={e} className="gf-chip">
            <input type="checkbox" checked onChange={() => toggle(e)} />
            {e.slice(6)}
          </label>
        ))}
      </div>
      <form
        className="gf-inline"
        onSubmit={(ev) => {
          ev.preventDefault();
          const t = other.trim();
          if (t) toggle(`other:${t}`);
          setOther("");
        }}
      >
        <input aria-label="Other equipment" placeholder="Other equipment" value={other} onChange={(e) => setOther(e.target.value)} />
        <button type="submit" className="btn btn-quiet">
          Add
        </button>
      </form>
    </section>
  );
}

function OverrideInput({ label, value, unit, onChange }: { label: string; value: number | null | undefined; unit: string | null; onChange: (v: number | null) => void }) {
  return (
    <input
      aria-label={label}
      className="gf-num"
      inputMode="decimal"
      placeholder="Your value"
      defaultValue={value ?? ""}
      onBlur={(e) => {
        const t = e.target.value.trim();
        const n = Number(t);
        onChange(t === "" || !Number.isFinite(n) ? null : n);
      }}
      title={unit ?? undefined}
    />
  );
}

function EconomicsEditor({ ctx }: { ctx: StepContext }) {
  const { sim, field, point } = ctx;
  const crops = cropsOf(sim.rotation);
  const [econ, setEcon] = useState<{ state: "idle" | "loading" } | { state: "ready"; data: Economics } | { state: "error"; message: string }>({ state: "idle" });
  const key = JSON.stringify([crops, sim.equipment, point]);
  useEffect(() => {
    if (!point || !crops.length || !field) return;
    let live = true;
    setEcon({ state: "loading" });
    void ctx.api.client.economics({ point, crops, area: { value: null, unit: "acre" }, equipment: sim.equipment, overrides: {} }).then((r) => {
      if (live) setEcon(r.ok ? { state: "ready", data: r.data } : { state: "error", message: r.message });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const setOverride = (crop: string, k: keyof CropOverride, v: number | null, unit: string) =>
    updateSimField(field!.field_id, (cur) => ({ overrides: { ...cur.overrides, [crop]: { ...cur.overrides[crop], [k]: v == null ? null : { value: v, unit } } } }));
  return (
    <section className="db-card" aria-label="Prices, yields and costs">
      <div className="db-card-head">
        <h2>Prices, yields and costs</h2>
      </div>
      <p className="gf-muted">Defaults come from published sources for this place. Type your own number to use it instead; a crop with neither has no money result.</p>
      {econ.state === "loading" ? <p className="gf-muted" role="status">Looking up sourced prices and costs…</p> : null}
      {econ.state === "error" ? <Banner kind="info">{econ.message} Your own numbers below still count.</Banner> : null}
      {crops.length ? (
        <table className="gf-table">
          <thead>
            <tr>
              <th scope="col">Crop</th>
              <th scope="col">Price (low · typical · high)</th>
              <th scope="col">Yield</th>
              <th scope="col">Costs</th>
            </tr>
          </thead>
          <tbody>
            {crops.map((c) => {
              const e = econ.state === "ready" ? econ.data.crops.find((x) => x.cropId === c) : undefined;
              const cur = econ.state === "ready" ? econ.data.currency : "USD";
              const o = sim.overrides[c] ?? {};
              return (
                <tr key={c}>
                  <th scope="row">
                    {cropLabel(c)}
                    {e?.status === "unavailable" ? <span className="gf-muted gf-block">{e.reasonText ?? "No sourced figures."}</span> : null}
                  </th>
                  <td>
                    {e?.price ? (
                      <span className="gf-cell">
                        {num(e.price.low, null, 2)} · <strong>{num(e.price.typical, null, 2)}</strong> · {num(e.price.high, null, 2)} {e.price.unit}
                        <OriginBadge origin={e.price.origin} title={e.price.source ? `${e.price.source.title}${e.price.source.years ? `, ${e.price.source.years}` : ""}` : undefined} />
                      </span>
                    ) : (
                      <span className="gf-muted">{NA}</span>
                    )}
                    <OverrideInput label={`${cropLabel(c)} price, yours`} value={o.price?.value} unit={e?.price?.unit ?? null} onChange={(v) => setOverride(c, "price", v, e?.price?.unit ?? `${cur}/unit`)} />
                  </td>
                  <td>
                    {e?.yield ? (
                      <span className="gf-cell">
                        {num(e.yield.value, e.yield.unit)}
                        <OriginBadge origin={e.yield.origin} title={e.yield.source?.title} />
                      </span>
                    ) : (
                      <span className="gf-muted">{NA}</span>
                    )}
                    <OverrideInput label={`${cropLabel(c)} yield, yours`} value={o.yield?.value} unit={e?.yield?.unit ?? null} onChange={(v) => setOverride(c, "yield", v, e?.yield?.unit ?? "unit/acre")} />
                  </td>
                  <td>
                    {e?.costs?.totalPerArea ? (
                      <span className="gf-cell">
                        {money(e.costs.totalPerArea.value, cur)} {e.costs.totalPerArea.unit?.replace(/^[A-Z]{3}/, "")}
                        {e.costs.items[0] ? <OriginBadge origin={e.costs.items[0].origin} title={e.costs.items.map((i) => `${i.item}: ${i.value ?? NA} ${i.unit ?? ""}`).join(", ")} /> : null}
                      </span>
                    ) : (
                      <span className="gf-muted">{NA}</span>
                    )}
                    <OverrideInput label={`${cropLabel(c)} costs per acre, yours`} value={o.costPerArea?.value} unit={e?.costs?.totalPerArea?.unit ?? null} onChange={(v) => setOverride(c, "costPerArea", v, e?.costs?.totalPerArea?.unit ?? `${cur}/acre`)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="gf-muted">Choose the crops in your rotation first.</p>
      )}
    </section>
  );
}

export function StepNow({ ctx }: { ctx: StepContext }) {
  const { field, sim } = ctx;
  const inputs = useInputsModule();
  const U3Equipment = pick(inputs, "EquipmentEditor");
  const U3Economics = pick(inputs, "EconomicsEditor");
  if (!field) return null;
  const setRotation = (r: FieldPlan[]) => {
    updateSimField(field.field_id, { rotation: r });
    // The farm map and the classic field tools read the field's first season.
    if (r[0] && planReady(r[0])) farmActions.setFieldPlan(field.field_id, r[0]);
  };
  return (
    <div className="gf-now">
      <section className="db-card" aria-label={`Current plan for ${field.name}`}>
        <div className="db-card-head">
          <h2>Current plan for {field.name}</h2>
          <span className={rotationReady(sim.rotation) ? "gf-ok" : "gf-muted"}>{rotationReady(sim.rotation) ? "Ready to simulate" : "Not complete yet"}</span>
        </div>
        <RotationEditor ctx={ctx} rotation={sim.rotation} onChange={setRotation} />
      </section>
      <div className="gf-two">
        {U3Equipment ? <U3Equipment fieldId={field.field_id} value={sim.equipment} onChange={(equipment: string[]) => updateSimField(field.field_id, { equipment })} client={ctx.api.client} /> : <EquipmentEditor ctx={ctx} />}
      </div>
      {U3Economics ? (
        <U3Economics fieldId={field.field_id} crops={cropsOf(sim.rotation)} point={ctx.point} overrides={sim.overrides} onChange={(overrides: Record<string, CropOverride>) => updateSimField(field.field_id, { overrides })} client={ctx.api.client} />
      ) : (
        <EconomicsEditor ctx={ctx} />
      )}
    </div>
  );
}
