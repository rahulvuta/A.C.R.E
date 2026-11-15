import { useEffect, useMemo, useState, type ReactNode } from "react";
import { areaHa, formatArea } from "../../farm/geometry";
import { farmActions } from "../../farm/hooks";
import type { Farm, Field } from "../../farm/types";
import { fieldPoint, useFieldPlace } from "../../state/useFieldPlace";
import type { GlobalApi } from "../../state/useGlobal";
import { hasSimField, removeSimField, updateSimField, useSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { rotationReady, type StepContext } from "../guided/context";
import { cropLabel } from "../guided/format";
import { cropsOf } from "../guided/context";
import type { StepId } from "../guided/steps";
import { StepCompare } from "../guided/StepCompare";
import { StepNow } from "../guided/StepNow";
import { ReadingsLog, StepPlan } from "../guided/StepPlan";
import { StepSimulate } from "../guided/StepSimulate";
import { StepTry } from "../guided/StepTry";
import { ResearchPanel } from "../workspace/ResearchPanel";

/*
  One field's workspace: seven sections that reuse the guided simulator's step components
  (rotation editor, simulation, comparison, plan finder, future plan) and the regional
  profile. Every section reads and writes the same per-field stores (`acre.farms.v1`,
  `acre.simfield.v1`), so a field's data is its own. Sections stay mounted once opened (just
  hidden), so a half-typed entry is not lost when moving between them.
*/
export const TABS = [
  { id: "overview", label: "Overview" },
  { id: "rotation", label: "Crop Rotation" },
  { id: "conditions", label: "Field Conditions" },
  { id: "recommendations", label: "Recommendations" },
  { id: "simulation", label: "Simulation" },
  { id: "financial", label: "Financial Analysis" },
  { id: "future", label: "Future Plan" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// The guided steps call ctx.go(step); here a step is a section.
const STEP_TO_TAB: Record<StepId, TabId> = { farm: "overview", now: "rotation", simulate: "simulation", try: "recommendations", compare: "simulation", plan: "future" };

export function FieldWorkspace({ api, farm, field, tab, onTab, onClose, onCopy }: { api: GlobalApi; farm: Farm; field: Field; tab: string; onTab: (t: string) => void; onClose: () => void; onCopy: () => void }) {
  const active: TabId = TABS.some((t) => t.id === tab) ? (tab as TabId) : "overview";
  const sim = useSimField(field.field_id);
  const place = useFieldPlace(api.client, field);
  const profile = place?.profile.state === "ready" ? place.profile.data : null;
  const regionKey = profile?.regionKey ?? (place?.place.state === "ready" ? (place.place.data.regionKeys[0] ?? null) : null);
  const point = useMemo(() => fieldPoint(field), [field]);
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([active]));
  useEffect(() => setVisited((v) => (v.has(active) ? v : new Set(v).add(active))), [active]);

  // A field this browser has not simulated yet starts from what the field itself carries.
  useEffect(() => {
    if (hasSimField(field.field_id)) return;
    updateSimField(field.field_id, {
      rotation: field.plan ? [field.plan] : [],
      equipment: field.equipment ?? [],
      readings: (field.readings ?? []).map((r) => ({ date: r.date, kind: r.kind, value: r.value, depthCm: r.depth_cm ?? null, note: r.note ?? null })),
    });
  }, [field]);

  const ctx: StepContext = { api, farm, field, sim, point, regionKey, profile, go: (s) => onTab(STEP_TO_TAB[s]) };
  const pane = (id: TabId, body: () => ReactNode) => (visited.has(id) ? <div key={id} role="tabpanel" id={`pane-${id}`} aria-labelledby={`tab-${id}`} hidden={active !== id} className="fw-pane">{body()}</div> : null);

  return (
    <section className="fw" aria-label={`Field ${field.name}`}>
      <div className="dash-bar">
        <div>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            ← All fields
          </button>
          <h1>{field.name}</h1>
        </div>
        <span className="dash-muted">{formatArea(field.geometry).ac} · {farm.demo ? `Demo: ${farm.demo}` : farm.name}</span>
      </div>
      {farm.demo ? (
        <Banner kind="synthetic">
          <strong>Demo farm.</strong> Example values, kept apart from your own fields.{" "}
          <button type="button" className="btn btn-quiet" onClick={onCopy}>Copy this field to my fields</button>
        </Banner>
      ) : null}
      <div className="fw-tabs" role="tablist" aria-label="Field sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={active === t.id} aria-controls={`pane-${t.id}`} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {pane("overview", () => <Overview ctx={ctx} farm={farm} field={field} onTab={onTab} onClose={onClose} />)}
      {pane("rotation", () => <StepNow ctx={ctx} part="rotation" />)}
      {pane("conditions", () => (
        <div className="gf-now">
          {profile ? <ResearchPanel profile={profile} field={field} /> : <p className="dash-muted">{place?.profile.state === "error" ? place.profile.message : "Loading this place's regional profile…"}</p>}
          <details className="db-card" open>
            <summary>Field measurements and readings</summary>
            <ReadingsLog ctx={ctx} />
          </details>
        </div>
      ))}
      {pane("recommendations", () => <StepTry ctx={ctx} />)}
      {pane("simulation", () => (
        <div className="gf-now">
          {rotationReady(sim.rotation) ? null : <Banner kind="info">Set a complete crop rotation first. <button type="button" className="btn btn-quiet" onClick={() => onTab("rotation")}>Open Crop Rotation</button></Banner>}
          <StepSimulate ctx={ctx} />
          {sim.scenarios.length ? <StepCompare ctx={ctx} /> : <p className="dash-muted">Add other plans under Recommendations to compare them here.</p>}
        </div>
      ))}
      {pane("financial", () => (
        <div className="gf-now">
          <p className="dash-muted">Your own prices, yields and costs. Anything left blank stays "not available"; regional references are labelled. The 10-year margin appears under Simulation.</p>
          <StepNow ctx={ctx} part="money" />
        </div>
      ))}
      {pane("future", () => <StepPlan ctx={ctx} />)}
    </section>
  );
}

function Overview({ ctx, farm, field, onTab, onClose }: { ctx: StepContext; farm: Farm; field: Field; onTab: (t: string) => void; onClose: () => void }) {
  const { sim } = ctx;
  const crops = cropsOf(sim.rotation).map(cropLabel).join(" → ");
  const ha = areaHa(field.geometry);
  return (
    <div className="gf-now">
      <section className="db-card" aria-label="Field details">
        <div className="db-card-head"><h2>Field details</h2></div>
        <label className="fw-name">
          <span>Field name</span>
          <input className="input" aria-label="Field name" defaultValue={field.name} onBlur={(e) => farmActions.updateField(field.field_id, { name: e.target.value })} />
        </label>
        <dl className="fw-facts">
          <div><dt>Acreage</dt><dd>{formatArea(field.geometry).ac} ({ha > 0 ? `${ha.toFixed(2)} ha` : "—"})</dd></div>
          <div><dt>Rotation</dt><dd>{crops || "Not set"} {sim.rotation.length ? <span className="dash-muted">({sim.rotation.length} {sim.rotation.length === 1 ? "season" : "seasons"})</span> : null}</dd></div>
          <div><dt>Status</dt><dd>{!sim.rotation.length ? "Needs a rotation" : rotationReady(sim.rotation) ? (sim.chosenId ? "Plan chosen" : "Rotation set") : "Rotation incomplete"}</dd></div>
          <div><dt>Farm</dt><dd>{farm.name}</dd></div>
        </dl>
        <div className="dash-actions">
          <button type="button" className="btn btn-primary" onClick={() => onTab("rotation")}>Edit crop rotation</button>
          <button type="button" className="btn btn-secondary" onClick={() => onTab("simulation")}>Run simulation</button>
          <button type="button" className="btn btn-quiet" onClick={() => { if (window.confirm(`Delete ${field.name}? This removes its boundary and settings from this browser.`)) { removeSimField(field.field_id); farmActions.deleteField(field.field_id); onClose(); } }}>
            Delete field
          </button>
        </div>
      </section>
    </div>
  );
}
