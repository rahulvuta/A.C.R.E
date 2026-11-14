import { useEffect, useState } from "react";
import { APP_NAME } from "../../config";
import { useFarms, useSelectedField, selectField } from "../../farm/hooks";
import { FarmMap } from "../../map/FarmMap";
import type { FieldState } from "../../map/fieldLayers";
import { useFarmAnalysis } from "../../state/useFarmAnalysis";
import { useFieldPlace } from "../../state/useFieldPlace";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { Banner } from "../../ui/components";
import { navIcon } from "../planner/SideNav";
import { FarmOverview } from "./FarmOverview";
import { FieldPlanEditor } from "./FieldPlanEditor";
import { CapabilityStates, FieldResults, ResolutionNotices } from "./FieldResults";
import { PlanningSlot, type PlanningStep } from "./PlanningSlot";
import { ResearchPanel } from "./ResearchPanel";

/*
  The global planner (cards D1–D4). The map is home: find the farm, draw fields. Then, per
  field: its plan, Goals → Find plans → Future plan. The farm overview lists every field (area
  is the only total). The Union County demo still opens offline from the saved record.
*/
export const DEMO_HREF = "?view=demo";

export function DemoLink({ className = "btn" }: { className?: string }) {
  return (
    <a className={className} href={DEMO_HREF}>
      Open the Union County demo
    </a>
  );
}

export function SourceBanner({ source }: { source: GlobalApi["source"] }) {
  if (source === "fixtures")
    return (
      <Banner kind="synthetic">
        <strong>Sample responses.</strong> Made-up answers for trying the screens; not NASA data and not your place.
      </Banner>
    );
  if (source === "none")
    return (
      <Banner kind="info">
        Finding a farm needs the A.C.R.E service, which is not connected in this build. The Union County demo works offline.
      </Banner>
    );
  return null;
}

type Page = "map" | "overview" | "plan" | PlanningStep;
const PAGES: Array<{ id: Page; label: string; icon: string; needsField?: boolean }> = [
  { id: "map", label: "Farm map", icon: "M9 16s5-4.500 5-8.500a5 5 0 0 0-10 0C4 11.500 9 16 9 16zM9 9.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
  { id: "overview", label: "Farm overview", icon: "M3 4h12M3 9h12M3 14h12" },
  { id: "plan", label: "Field plan", icon: "M4 3h10v12H4zM7 7h4M7 10h4", needsField: true },
  { id: "goals", label: "Goals", icon: "M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12zM9 11.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5z", needsField: true },
  { id: "find", label: "Find plans", icon: "M8 13A5 5 0 1 0 8 3a5 5 0 0 0 0 10zM11.500 11.500L15 15", needsField: true },
  { id: "future", label: "Future plan", icon: "M3 5h12v10H3zM3 8h12M6 3v3M12 3v3", needsField: true },
];
const TITLE: Record<Page, string> = { map: "Find your farm", overview: "Farm overview", plan: "Field plan", goals: "Goals", find: "Find plans", future: "Future plan" };

function readPage(): Page {
  const m = window.location.hash.match(/[#&]w=([a-z]+)/);
  const p = m?.[1] as Page | undefined;
  return p && PAGES.some((x) => x.id === p) ? p : "map";
}

export function Workspace({ api: given }: { api?: GlobalApi }) {
  const fallback = useGlobalApi();
  const api = given ?? fallback;
  const { farm, farms } = useFarms();
  const field = useSelectedField();
  const [page, setPageState] = useState<Page>(readPage);
  const setPage = (p: Page) => {
    setPageState(p);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#w=${p}`);
  };
  const { analysis, analyze } = useFarmAnalysis(api.client, farm);
  const place = useFieldPlace(api.client, field);
  const profile = place?.profile.state === "ready" ? place.profile.data : null;
  const ready = analysis.state === "ready" ? analysis : null;
  const fieldResult = field && ready ? (ready.data.fields.find((f) => f.fieldId === field.field_id) ?? null) : null;
  const seasonLabel = fieldResult?.result?.seasonLabel ?? (place?.place.state === "ready" && place.place.data.hemisphere === "south" ? "Off-season" : "Winter");
  const planned = farm?.fields.filter((f) => f.plan).length ?? 0;

  // A page that needs a field falls back to the map when there is none.
  useEffect(() => {
    if (!field && PAGES.find((p) => p.id === page)?.needsField) setPageState("map");
  }, [field, page]);

  const fieldStates: Record<string, FieldState> = {};
  for (const f of ready?.data.fields ?? []) fieldStates[f.fieldId] = f.jobStatus === "pending" ? "pending" : f.result ? (f.result.rules.some((r) => r.verdict === "caution" || r.verdict === "avoid") ? "flagged" : "ready") : "unavailable";

  const analyzeButton = farm ? (
    <button type="button" className="btn btn-primary" onClick={analyze} disabled={!planned || analysis.state === "loading"}>
      {analysis.state === "loading" ? "Analysing…" : ready?.stale ? "Analyse again" : "Analyse farm"}
    </button>
  ) : null;

  return (
    <div className="db ws">
      <aside className="db-side">
        <a className="db-brand" href="./" aria-label={`${APP_NAME} home`}>
          <span className="fb-mark" aria-hidden="true" />
          {APP_NAME}
        </a>
        <nav className="db-nav" aria-label="Pages">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={page === p.id ? "page" : undefined}
              disabled={(p.needsField && !field) || (p.id === "overview" && !farm)}
              onClick={() => setPage(p.id)}
            >
              {navIcon(p.icon)}
              {p.label}
            </button>
          ))}
        </nav>
        <div className="db-side-foot">
          <div className="db-links">
            <a href={DEMO_HREF}>
              {navIcon("M3 8l6-5 6 5v7H3zM7.500 15v-4h3v4")}
              Union County demo
            </a>
            <a href="?view=methods">{navIcon("M9 16A7 7 0 1 0 9 2a7 7 0 0 0 0 14zM7 7a2 2 0 1 1 3 1.700c-.600.400-1 .800-1 1.500M9 12.700v.100")}How it works</a>
            <a href="?view=privacy">{navIcon("M9 2l5.500 2v4.500c0 3.500-2.300 6-5.500 7.500-3.200-1.500-5.500-4-5.500-7.500V4zM6.700 9l1.700 1.700 3-3.200")}Privacy and terms</a>
          </div>
        </div>
      </aside>
      <div className="db-body">
        <header className="db-top">
          <div className="db-crumbs">
            <h1>{TITLE[page]}</h1>
            {farm && farm.fields.length ? (
              <label className="ws-switch">
                <span>Field</span>
                <select aria-label="Selected field" value={field?.field_id ?? ""} onChange={(e) => selectField(e.target.value || null)}>
                  {!field ? <option value="">Choose a field</option> : null}
                  {farm.fields.map((f) => (
                    <option key={f.field_id} value={f.field_id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="db-top-actions">
            {analyzeButton}
            {page === "map" && !farms.length ? <DemoLink /> : null}
          </div>
        </header>
        <main className="db-main ws-main">
          <SourceBanner source={api.source} />
          {analysis.state === "error" ? (
            <Banner kind="error">
              <strong>{analysis.message}</strong>
              {analysis.issues.map((i) => (
                <span key={i} className="error-detail"> {i}</span>
              ))}
            </Banner>
          ) : null}
          {page === "map" ? (
            <div className="ws-map">
              <FarmMap
                api={api.geo}
                fieldStates={fieldStates}
                weatherCells={(ready?.data.weatherCells ?? []).flatMap((c) => (c.center && c.sizeDeg ? [{ cellId: c.cellId, center: c.center, sizeDeg: c.sizeDeg, fieldIds: c.fieldIds, note: c.note }] : []))}
              >
                {field ? (
                  <div className="ws-open">
                    <button type="button" className="btn btn-primary" onClick={() => setPage("plan")}>
                      Plan {field.name}
                    </button>
                  </div>
                ) : !farms.length ? (
                  <p className="ws-hint">
                    Or <DemoLink className="ws-link" />, which works offline.
                  </p>
                ) : null}
              </FarmMap>
            </div>
          ) : null}
          {page === "overview" && farm ? <FarmOverview farm={farm} analysis={ready?.data ?? null} onOpen={(id) => (selectField(id), setPage("plan"))} /> : null}
          {page === "plan" && field ? (
            <div className="ws-field">
              <FieldPlanEditor key={field.field_id} field={field} profile={profile} seasonLabel={seasonLabel} />
              <section className="db-card" aria-label="Results for this field">
                <div className="db-card-head">
                  <h2>What past weather says</h2>
                </div>
                {ready?.stale ? <p className="fr-state">Plans changed since the last analysis. Analyse again to update.</p> : null}
                {fieldResult ? <FieldResults field={fieldResult} /> : <p className="fr-state">{field.plan ? "Analyse the farm to see this field's results." : "Save a plan, then analyse the farm."}</p>}
                <ResolutionNotices analysis={ready?.data ?? null} field={fieldResult} profile={profile} caps={fieldResult?.capabilities ?? null} />
                <CapabilityStates caps={fieldResult?.capabilities ?? null} />
                <div className="ws-next">
                  <button type="button" className="btn btn-secondary" onClick={() => setPage("goals")}>
                    Set goals for this field
                  </button>
                </div>
              </section>
              {profile ? <ResearchPanel profile={profile} field={field} /> : place?.profile.state === "error" ? <p className="fr-state">{place.profile.message}</p> : null}
            </div>
          ) : null}
          {(page === "goals" || page === "find" || page === "future") && field && place ? (
            <PlanningSlot step={page} client={api.client} field={field} point={place.point} profile={profile} onStep={(s) => setPage(s)} />
          ) : null}
        </main>
      </div>
    </div>
  );
}
