import { useEffect, useMemo, useState, type ReactNode } from "react";
import { areaHa, formatArea } from "../../farm/geometry";
import { farmActions } from "../../farm/hooks";
import type { Farm, Field } from "../../farm/types";
import { fieldPoint, useFieldPlace } from "../../state/useFieldPlace";
import type { GlobalApi } from "../../state/useGlobal";
import { hasSimField, removeSimField, updateSimField, useSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import type { StepContext } from "../guided/context";
import { cropLabel } from "../guided/format";
import { cropsOf } from "../guided/context";
import type { StepId } from "../guided/steps";
import { StepNow } from "../guided/StepNow";
import { ReadingsLog, StepPlan } from "../guided/StepPlan";
import { StepTry } from "../guided/StepTry";
import { StrategyView } from "./StrategyBoxes";
import { ResearchPanel } from "../workspace/ResearchPanel";

/*
  One field's workspace: the Overview runs the simulation and shows the plans side by side; the other sections that reuse the guided simulator's step components
  (rotation editor, plan finder, future plan) and the regional
  profile. Every section reads and writes the same per-field stores (`acre.farms.v1`,
  `acre.simfield.v1`), so a field's data is its own. Sections stay mounted once opened (just
  hidden), so a half-typed entry is not lost when moving between them.
*/
export const TABS = [
  { id: "overview", label: "Overview" },
  { id: "rotation", label: "Crop Rotation" },
  { id: "conditions", label: "Field Conditions" },
  { id: "recommendations", label: "Recommendations" },
  { id: "financial", label: "Financial Analysis" },
  { id: "future", label: "Future Plan" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// The guided steps call ctx.go(step); here a step is a section.
const STEP_TO_TAB: Record<StepId, TabId> = { farm: "overview", now: "rotation", simulate: "overview", try: "recommendations", compare: "overview", plan: "future" };

export function FieldWorkspace({ api, farm, field, tab, onTab, onClose, onCopy }: { api: GlobalApi; farm: Farm; field: Field; tab: string; onTab: (t: string) => void; onClose: () => void; onCopy: () => void; onOpenField?: (id: string) => void }) {
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
  const ctxFor = (id: TabId): StepContext => ({ ...ctx, active: active === id });
  const pane = (id: TabId, body: () => ReactNode) => (visited.has(id) ? <div key={id} role="tabpanel" id={`pane-${id}`} aria-label={TABS.find((t) => t.id === id)!.label} hidden={active !== id} className="fw-pane">{body()}</div> : null);

  return (
    <section className="fw" aria-label={`Field ${field.name}`}>
      {farm.demo ? (
        <Banner kind="synthetic">
          <strong>Demo farm.</strong> Example values, kept apart from your own fields.{" "}
          <button type="button" className="btn btn-quiet" onClick={onCopy}>Copy this field to my fields</button>
        </Banner>
      ) : null}
      {pane("overview", () => <Overview ctx={ctxFor("overview")} field={field} onTab={onTab} onClose={onClose} />)}
      {pane("rotation", () => <>
        <StepNow ctx={ctx} part="rotation" />
        <div className="dash-actions">
          <span className="dash-muted">Changes are saved automatically.</span>
          <button type="button" className="btn btn-primary" onClick={() => onTab("overview")}>Done, back to field</button>
        </div>
      </>)}
      {pane("conditions", () => (
        <div className="gf-now">
          {profile ? <ResearchPanel profile={profile} field={field} /> : <p className="dash-muted">{place?.profile.state === "error" ? place.profile.message : "Loading this place's regional profile…"}</p>}
          <details className="db-card" open>
            <summary>Field measurements and readings</summary>
            <ReadingsLog ctx={ctx} />
          </details>
        </div>
      ))}
      {pane("recommendations", () => <StepTry ctx={ctxFor("recommendations")} />)}
      {pane("financial", () => (
        <div className="gf-now">
          <p className="dash-muted">Your own prices, yields and costs. Anything left blank stays "not available"; regional references are labelled. The 10-year margin appears on the Overview.</p>
          <StepNow ctx={ctx} part="money" />
        </div>
      ))}
      {pane("future", () => <StepPlan ctx={ctxFor("future")} />)}
    </section>
  );
}

function Overview({ ctx, field, onTab, onClose }: { ctx: StepContext; field: Field; onTab: (t: string) => void; onClose: () => void }) {
  const { sim } = ctx;
  const crops = cropsOf(sim.rotation).map(cropLabel).join(" → ");
  const ha = areaHa(field.geometry);
  return (
    <div className="gf-now">
      <section className="db-card fw-strip" aria-label="Field details">
        <input className="input fw-strip-name" aria-label="Field name" defaultValue={field.name} onBlur={(e) => farmActions.updateField(field.field_id, { name: e.target.value })} />
        <span className="fw-strip-facts">
          <span>{formatArea(field.geometry).ac}{ha > 0 ? ` (${ha.toFixed(1)} ha)` : ""}</span>
          <span>{crops || "No rotation yet"}</span>
        </span>
        <span className="fw-strip-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onTab("rotation")}>Edit crop rotation</button>
          <button type="button" className="btn btn-secondary" onClick={() => onTab("financial")}>Edit prices and costs</button>
          <button type="button" className="btn btn-quiet" onClick={() => { if (window.confirm(`Delete ${field.name}? This removes its boundary and settings from this browser.`)) { removeSimField(field.field_id); farmActions.deleteField(field.field_id); onClose(); } }}>
            Delete field
          </button>
        </span>
      </section>
      <StrategyView ctx={ctx} onTab={onTab} />
    </div>
  );
}
