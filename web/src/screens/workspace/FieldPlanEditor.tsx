import { useMemo, useState } from "react";
import type { Origin, RegionProfile } from "../../api/model";
import { farmActions } from "../../farm/hooks";
import type { Field, FieldPlan } from "../../farm/types";
import { clearDraft, setDraft, useDraft } from "../../state/drafts";
import { OriginBadge } from "../../ui/OriginBadge";

/*
  The plan editor for one field (card D2). Crops and covers come from the place's regional
  profile; "My crop isn't listed" is free entry saved as `grower`. Dates start from the
  profile's calendar (shown with that calendar's origin) and become `grower` once edited.
  The backend checks every date when the farm is analysed; nothing is judged here.
*/
const OTHER = "__other__";
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function emptyPlan(field: Field): FieldPlan {
  return {
    plan_id: `${field.field_id}_plan`,
    previous_crop_id: "",
    next_crop_id: "",
    prev_harvest: "",
    next_plant: "",
    winter: { kind: "none" },
    grower: { low_moisture_concern: null },
    origins: {},
  };
}

export function planComplete(p: FieldPlan | null): boolean {
  if (!p) return false;
  const md = /^\d{2}-\d{2}$/;
  if (!p.previous_crop_id || !p.next_crop_id || !md.test(p.prev_harvest) || !md.test(p.next_plant)) return false;
  if (p.winter.kind === "cover") return Boolean(p.winter.crop_id) && md.test(p.winter.seed) && md.test(p.winter.terminate);
  if (p.winter.kind === "winter_grain") return Boolean(p.winter.crop_id) && md.test(p.winter.plant) && md.test(p.winter.harvest);
  return true;
}

function CropSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ id: string; name: string }>;
  onChange: (cropId: string, typed: boolean) => void;
}) {
  const listed = options.some((o) => o.id === value);
  // Free entry when the grower chose it, or when the saved crop is not in this place's list.
  const [forced, setOther] = useState(false);
  const other = forced || (Boolean(value) && !listed);
  return (
    <div className="pe-row">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={other ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setOther(true);
            onChange("", true);
          } else {
            setOther(false);
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
        <option value={OTHER}>My crop isn't listed</option>
      </select>
      {other ? (
        <input aria-label={`${label}: your crop`} placeholder="Type the crop" defaultValue={listed ? "" : value} onChange={(e) => onChange(slug(e.target.value), true)} />
      ) : null}
    </div>
  );
}

function DateInput({ id, label, value, origin, onChange }: { id: string; label: string; value: string; origin?: Origin; onChange: (v: string) => void }) {
  return (
    <div className="pe-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} placeholder="MM-DD" pattern="\d{2}-\d{2}" inputMode="numeric" onChange={(e) => onChange(e.target.value)} />
      {value && origin ? <OriginBadge origin={origin} /> : null}
    </div>
  );
}

export function FieldPlanEditor({ field, profile, seasonLabel }: { field: Field; profile: RegionProfile | null; seasonLabel: string }) {
  const draft = useDraft(field.field_id);
  const plan = draft ?? field.plan ?? emptyPlan(field);
  const dirty = draft != null;
  const crops = useMemo(() => (profile?.crops ?? []).map((c) => ({ id: c.cropId, name: c.name })), [profile]);
  const covers = useMemo(() => (profile?.covers ?? []).map((c) => ({ id: c.cropId, name: c.name })), [profile]);
  const calendar = (id: string) => profile?.crops.find((c) => c.cropId === id)?.calendar ?? null;
  const dateOrigin = plan.origins?.dates;

  const edit = (next: Partial<FieldPlan>) => setDraft(field.field_id, { ...plan, ...next });
  const editWinter = (w: FieldPlan["winter"]) => edit({ winter: w, origins: { ...plan.origins, winter: "grower" } });

  const pickCrop = (which: "previous_crop_id" | "next_crop_id", id: string, typed: boolean) => {
    const next: Partial<FieldPlan> = { [which]: id, origins: { ...plan.origins, crops: typed ? "grower" : (plan.origins?.crops ?? (profile?.status === "complete" ? "verified_source" : "dataset_estimate")) } };
    // A date left blank starts from the profile's calendar for that crop, labelled with its origin.
    const cal = typed ? null : calendar(id);
    if (cal && which === "previous_crop_id" && !plan.prev_harvest && cal.harvest) Object.assign(next, { prev_harvest: cal.harvest.start, origins: { ...next.origins, dates: cal.origin } });
    if (cal && which === "next_crop_id" && !plan.next_plant && cal.plant) Object.assign(next, { next_plant: cal.plant.start, origins: { ...next.origins, dates: cal.origin } });
    edit(next);
  };
  const setDate = (k: "prev_harvest" | "next_plant", v: string) => edit({ [k]: v, origins: { ...plan.origins, dates: "grower" } });

  const save = () => {
    farmActions.setFieldPlan(field.field_id, plan);
    clearDraft(field.field_id);
  };

  return (
    <section className="db-card pe" aria-label={`Plan for ${field.name}`}>
      <div className="db-card-head">
        <h2>Plan for {field.name}</h2>
      </div>
      {profile?.disclaimer && profile.status !== "complete" ? <p className="pe-note">{profile.disclaimer}</p> : null}
      <div className="pe-grid">
        <CropSelect id={`pe-prev-${field.field_id}`} label="Crop before" value={plan.previous_crop_id} options={crops} onChange={(id, t) => pickCrop("previous_crop_id", id, t)} />
        <DateInput id={`pe-harv-${field.field_id}`} label="Its harvest" value={plan.prev_harvest} origin={dateOrigin} onChange={(v) => setDate("prev_harvest", v)} />
        <div className="pe-row">
          <label htmlFor={`pe-wk-${field.field_id}`}>{seasonLabel}</label>
          <select
            id={`pe-wk-${field.field_id}`}
            value={plan.winter.kind}
            onChange={(e) => {
              const k = e.target.value as FieldPlan["winter"]["kind"];
              editWinter(k === "none" ? { kind: "none" } : k === "cover" ? { kind: "cover", crop_id: "", seed: "", terminate: "" } : { kind: "winter_grain", crop_id: "", plant: "", harvest: "" });
            }}
          >
            <option value="none">Nothing planted</option>
            <option value="cover">A cover crop</option>
            <option value="winter_grain">A grain crop</option>
          </select>
        </div>
        {plan.winter.kind === "cover" ? (
          <>
            <CropSelect id={`pe-cov-${field.field_id}`} label="Cover crop" value={plan.winter.crop_id} options={covers.length ? covers : crops} onChange={(id) => editWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "cover" }>), crop_id: id })} />
            <DateInput id={`pe-seed-${field.field_id}`} label="Seed" value={plan.winter.seed} origin="grower" onChange={(v) => editWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "cover" }>), seed: v })} />
            <DateInput id={`pe-term-${field.field_id}`} label="End the cover" value={plan.winter.terminate} origin="grower" onChange={(v) => editWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "cover" }>), terminate: v })} />
          </>
        ) : null}
        {plan.winter.kind === "winter_grain" ? (
          <>
            <CropSelect id={`pe-wg-${field.field_id}`} label="Grain crop" value={plan.winter.crop_id} options={crops} onChange={(id) => editWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "winter_grain" }>), crop_id: id })} />
            <DateInput id={`pe-wgp-${field.field_id}`} label="Plant" value={plan.winter.plant} origin="grower" onChange={(v) => editWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "winter_grain" }>), plant: v })} />
            <DateInput id={`pe-wgh-${field.field_id}`} label="Harvest" value={plan.winter.harvest} origin="grower" onChange={(v) => editWinter({ ...(plan.winter as Extract<FieldPlan["winter"], { kind: "winter_grain" }>), harvest: v })} />
          </>
        ) : null}
        <CropSelect id={`pe-next-${field.field_id}`} label="Next crop" value={plan.next_crop_id} options={crops} onChange={(id, t) => pickCrop("next_crop_id", id, t)} />
        <DateInput id={`pe-plant-${field.field_id}`} label="Its planting" value={plan.next_plant} origin={dateOrigin} onChange={(v) => setDate("next_plant", v)} />
      </div>
      <div className="pe-actions">
        <button type="button" className="btn btn-primary" disabled={!dirty || !planComplete(plan)} onClick={save}>
          Save plan
        </button>
        {dirty ? (
          <button type="button" className="btn btn-quiet" onClick={() => clearDraft(field.field_id)}>
            Discard changes
          </button>
        ) : null}
        <span className="pe-hint" role="status">
          {dirty ? (planComplete(plan) ? "Unsaved changes" : "Fill in every crop and date to save") : field.plan ? "Saved" : "No plan yet"}
        </span>
      </div>
    </section>
  );
}
