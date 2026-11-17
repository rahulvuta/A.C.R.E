import { lazy, Suspense, useEffect, useState } from "react";
import { APP_NAME } from "../../config";
import { farmActions, putFarm, selectField, useFarms } from "../../farm/hooks";
import { areaM2, centroid } from "../../farm/geometry";
import { areaText, useUnits } from "../../ui/units";
import { UnitsControl } from "../../ui/UnitsControl";
import { OfflineNote } from "../../ui/OfflineNote";
import { LanguagePicker } from "../../i18n/LanguagePicker";
import type { Farm, Field } from "../../farm/types";
import { useFieldPlace } from "../../state/useFieldPlace";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { getSimField, loadDemoFields, removeSimField, updateSimField, useSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { SourceBanner } from "../workspace/SourceBanner";
import { cropsOf, rotationReady } from "../guided/context";
import { STEPS } from "../guided/steps";
import { cropLabel } from "../guided/format";
import { FieldWorkspace } from "./FieldWorkspace";
import { nextStep } from "../guided/progress";
export { nextStep } from "../guided/progress";
import { navIcon } from "../planner/SideNav";

/*
  The front door of the app: an empty farm dashboard. Fields are cards; "Add field" opens the
  existing map editor (FarmMap); a field opens its own workspace. Demo farms are loaded only
  on request, are flagged (`farm.demo`) and listed apart from the grower's own fields; a demo
  field can be copied into the grower's fields. Everything stays in this browser.
*/
type Route = { page: "fields" } | { page: "add" } | { page: "field"; id: string; tab: string };

// The map editor (MapLibre) loads only when a field is being added.
const FarmMap = lazy(() => import("../../map/FarmMap").then((m) => ({ default: m.FarmMap })));

function readRoute(): Route {
  const m = window.location.hash.match(/[#&]d=([^&]*)/);
  const v = m?.[1] ?? "";
  if (v === "add") return { page: "add" };
  const f = v.match(/^f\/([^/]+)\/?([a-z]*)$/);
  if (f) return { page: "field", id: decodeURIComponent(f[1]!), tab: f[2] || "overview" };
  return { page: "fields" };
}
const hashFor = (r: Route) => (r.page === "add" ? "#d=add" : r.page === "field" ? `#d=f/${encodeURIComponent(r.id)}/${r.tab}` : "#d=fields");

export const DEMOS = [
  { id: "union" as const, name: "United States: Union County, North Carolina", blurb: "Maize and soybean fields, with a winter between the crops." },
  { id: "pergamino" as const, name: "Argentina: Pergamino, Buenos Aires", blurb: "Soybean, maize and wheat, with southern-hemisphere seasons." },
];

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (r: Route) => {
    setRoute(r);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hashFor(r)}`);
    window.scrollTo?.({ top: 0 });
  };
  return [route, go];
}

/** Copies a demo field (and its simulator settings) into a farm of the grower's own. */
export function copyToMyFields(demoFarm: Farm, field: Field, mine: Farm | null): string {
  const target = mine ?? farmActions.createFarm("My farm", demoFarm.anchor);
  const copy = farmActions.addField(target.farm_id, field.geometry, field.name);
  farmActions.updateField(copy.field_id, { plan: field.plan, ...(field.notes ? { notes: field.notes } : {}), ...(field.equipment ? { equipment: field.equipment } : {}), ...(field.readings ? { readings: field.readings } : {}) } as Partial<Field>);
  const sim = getSimField(field.field_id);
  updateSimField(copy.field_id, { ...sim, demo: null });
  return copy.field_id;
}

export function Dashboard({ api: given }: { api?: GlobalApi }) {
  const fallback = useGlobalApi();
  const api = given ?? fallback;
  const { farms, notice, selectedFarm } = useFarms();
  const units = useUnits();
  const [route, go] = useRoute();
  // However the add page is reached (button, reload, shared link), the map editor never
  // starts on a demo farm: a new field goes into the grower's own farm.
  const ownFarmId = farms.find((f) => !f.demo)?.farm_id ?? null;
  useEffect(() => {
    if (route.page === "add" && selectedFarm?.demo) farmActions.selectFarm(ownFarmId);
  }, [route.page, selectedFarm, ownFarmId]);
  const [demo, setDemo] = useState<{ state: "idle" } | { state: "loading"; which: string } | { state: "error"; message: string }>({ state: "idle" });
  const mine = farms.filter((f) => !f.demo);
  const demos = farms.filter((f) => f.demo);
  const myFields = mine.flatMap((f) => f.fields.map((x) => ({ farm: f, field: x })));
  const demoFields = demos.flatMap((f) => f.fields.map((x) => ({ farm: f, field: x })));

  const loadDemo = async (which: "union" | "pergamino") => {
    setDemo({ state: "loading", which });
    const r = await api.client.demoFarm(which);
    if (!r.ok) return setDemo({ state: "error", message: r.message });
    putFarm({ ...r.data.farm, demo: r.data.label });
    loadDemoFields(r.data);
    setDemo({ state: "idle" });
    const first = r.data.farm.fields[0];
    if (first) {
      selectField(first.field_id);
      go({ page: "field", id: first.field_id, tab: "overview" });
    }
  };

  const open = (id: string, tab = "overview") => {
    selectField(id);
    go({ page: "field", id, tab });
  };
  const startAdd = () => {
    // New fields always go into the grower's own farm, never into a demo farm.
    const keep = mine[0];
    if (keep) farmActions.selectFarm(keep.farm_id);
    else farmActions.selectFarm(null);
    // The guided sequence owns adding a field: step 1 is the same map, and it leads on to step 2.
    window.location.assign("?view=app#u=farm");
  };

  const fieldId = route.page === "field" ? route.id : null;
  const current = fieldId ? farms.flatMap((f) => f.fields.map((x) => ({ farm: f, field: x }))).find((x) => x.field.field_id === fieldId) : null;

  const title = route.page === "add" ? "Add a field" : current ? current.field.name : "Field";
  const onFieldPage = route.page === "field" && current;

  // The start page has no sidebar: one big button to begin, the grower's fields under it, and
  // the example farms folded away at the bottom. The sidebar starts once a field is open.
  if (route.page === "fields") {
    return (
      <div className="wl dh">
        <header className="wl-top">
          <a className="wl-brand dh-brand" href="?" aria-label={`${APP_NAME} start page`}>
            <span className="fb-mark" aria-hidden="true" />
            {APP_NAME}
          </a>
          <LanguagePicker />
          <nav className="wl-links" aria-label="About">
            <a href="?view=methods">How it works</a>
            <a href="?view=privacy">Privacy</a>
          </nav>
        </header>
        <main className="dh-main" data-empty={myFields.length ? "no" : "yes"}>
          <SourceBanner source={api.source} />
          <OfflineNote />
          {notice ? <Banner kind="info">{notice}</Banner> : null}
          <section className="dh-start" aria-label={myFields.length ? "Add a field" : "Create your farm"}>
            <button type="button" className="dh-create" onClick={startAdd}>
              <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 20l12-8 22 6-4 20-18 4-10-8z" />
                <path d="M24 19v12M18 25h12" />
              </svg>
              <span>{myFields.length ? "Add a field" : "Create your farm"}</span>
            </button>
            <p className="dh-fact">No account. Saved in this browser.</p>
          </section>
          {myFields.length ? (
            <section className="dh-fields" aria-labelledby="dh-fields-title">
              <h1 id="dh-fields-title">Your fields</h1>
              <ul className="dash-grid" aria-label="Your fields">
                {myFields.map(({ farm, field }) => (
                  <FieldCard key={field.field_id} api={api} farm={farm} field={field} onOpen={() => open(field.field_id)} />
                ))}
              </ul>
            </section>
          ) : null}
          <details className="dh-examples">
            <summary>
              Example farms{demoFields.length ? <span className="dh-count">{demoFields.length}</span> : null}
            </summary>
            <div className="dh-examples-body" role="group" aria-label="Example farms">
              {demoFields.length ? (
                <ul className="dash-grid" aria-label="Demo fields">
                  {demoFields.map(({ farm, field }) => (
                    <FieldCard key={field.field_id} api={api} farm={farm} field={field} onOpen={() => open(field.field_id)} />
                  ))}
                </ul>
              ) : null}
              <div className="gf-demo-row">
                {DEMOS.map((d) => {
                  const loaded = demos.some((f) => f.demo && f.name.toLowerCase().includes(d.id === "union" ? "union" : "pergamino"));
                  return (
                    <button key={d.id} type="button" className="gf-demo-btn" onClick={() => void loadDemo(d.id)} disabled={demo.state === "loading"}>
                      <strong>{demo.state === "loading" && demo.which === d.id ? "Loading…" : d.name}</strong>
                      <span>{d.blurb}</span>
                      {loaded ? <span>Load again (resets its example values)</span> : null}
                    </button>
                  );
                })}
              </div>
              {demo.state === "error" ? <Banner kind="error">{demo.message}</Banner> : null}
              {demos.length ? (
                <button type="button" className="btn btn-quiet dh-remove" onClick={() => demos.forEach((f) => (f.fields.forEach((x) => removeSimField(x.field_id)), farmActions.deleteFarm(f.farm_id)))}>
                  Remove example farms
                </button>
              ) : null}
            </div>
          </details>
        </main>
      </div>
    );
  }

  return (
    <div className="db ws gf dash">
      <aside className="db-side">
        <a className="db-brand" href="?" aria-label={`${APP_NAME} dashboard`}>
          <span className="fb-mark" aria-hidden="true" />
          {APP_NAME}
        </a>
        <nav className="gf-steps" aria-label="Main">
          <ol>
            <li>
              <button type="button" onClick={() => go({ page: "fields" })}>
                <span className="gf-dot" aria-hidden="true">{navIcon("M3 3h5v5H3zM10 3h5v5h-5zM3 10h5v5H3zM10 10h5v5h-5z")}</span>
                <span>All fields</span>
              </button>
            </li>
            <li>
              <button type="button" aria-current={route.page === "add" ? "step" : undefined} onClick={startAdd}>
                <span className="gf-dot" aria-hidden="true">+</span>
                <span>Add a field</span>
              </button>
            </li>
          </ol>
        </nav>
        <div className="db-side-foot">
          <LanguagePicker compact />
          <UnitsControl />
          <div className="db-links">
            <a href="?view=app">{navIcon("M4 4h10M4 9h10M4 14h6")}The six steps</a>
            <a href="?view=methods">{navIcon("M9 16A7 7 0 1 0 9 2a7 7 0 0 0 0 14zM7 7a2 2 0 1 1 3 1.700c-.600.400-1 .800-1 1.500M9 12.700v.100")}How it works</a>
            <a href="?view=privacy">{navIcon("M9 2l5.500 2v4.500c0 3.500-2.300 6-5.500 7.500-3.200-1.500-5.500-4-5.500-7.500V4zM6.700 9l1.700 1.700 3-3.200")}Privacy and terms</a>
            <a href="?view=home">{navIcon("M9 16A7 7 0 1 0 9 2a7 7 0 0 0 0 14zM9 8v5M9 5.500v.100")}About A.C.R.E</a>
          </div>
        </div>
      </aside>
      <div className="db-body">
        <header className="db-top">
          <div className="db-crumbs">
            {onFieldPage ? (
              <button type="button" className="btn btn-quiet dash-back" onClick={() => go({ page: "fields" })}>
                ← All fields
              </button>
            ) : null}
            <h1 translate={onFieldPage ? "no" : undefined}>{title}</h1>
            {onFieldPage ? <span className="dash-muted">{areaText(areaM2(current.field.geometry), units).main}</span> : null}
            {onFieldPage && current.farm.demo ? <span className="gf-demo-tag">Demo farm</span> : null}
          </div>
          {route.page === "add" ? (
            <button type="button" className="btn btn-primary" onClick={() => go({ page: "fields" })}>
              Done, back to fields
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={startAdd}>
              Add field
            </button>
          )}
        </header>
        <main className="db-main ws-main gf-main">
          <SourceBanner source={api.source} />
          <OfflineNote />
          {notice ? <Banner kind="info">{notice}</Banner> : null}
          {route.page === "add" ? (
            <section aria-label="Add a field" className="gf-farm">
              <header className="gf-head">
                <h2 className="gf-question">Where is your field?</h2>
                <p className="gf-sentence">Find your farm on the map, draw the boundary and name the field. Its size shows as soon as you finish the shape.</p>
              </header>
              <div className="ws-map gf-map">
                <Suspense fallback={<p className="gf-muted">Loading the map…</p>}>
                  <FarmMap api={api.geo} />
                </Suspense>
              </div>
            </section>
          ) : null}
          {route.page === "field" ? (
            current ? (
              <FieldWorkspace key={current.field.field_id} api={api} farm={current.farm} field={current.field} tab={route.tab} onTab={(tab) => go({ page: "field", id: current.field.field_id, tab })} onClose={() => go({ page: "fields" })} onOpenField={(id) => open(id)} onCopy={() => { const id = copyToMyFields(current.farm, current.field, mine[0] ?? null); open(id); }} />
            ) : (
              <Banner kind="info">
                That field is not saved in this browser. <button type="button" className="btn btn-quiet" onClick={() => go({ page: "fields" })}>Back to fields</button>
              </Banner>
            )
          ) : null}
        </main>
      </div>
    </div>
  );
}

function FieldCard({ api, farm, field, onOpen }: { api: GlobalApi; farm: Farm; field: Field; onOpen: () => void }) {
  const sim = useSimField(field.field_id);
  const place = useFieldPlace(api.client, field);
  const area = areaText(areaM2(field.geometry), useUnits());
  const loc = place?.place.state === "ready" ? [place.place.data.admin2Name, place.place.data.admin1Name, place.place.data.countryName].filter(Boolean).join(", ") : "";
  const c = centroid(field.geometry);
  const coords = `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)}`;
  // Every crop on the field, a grazed pasture included (nothing is sold from it, and it is still what grows there).
  const lasting = sim.rotation.find((p) => p.permanent)?.next_crop_id;
  const crops = lasting ? cropLabel(lasting) : sim.rotation.length ? cropsOf(sim.rotation).map(cropLabel).join(" → ") : field.plan ? cropsOf([field.plan]).map(cropLabel).join(" → ") : "";
  const step = STEPS.find((s) => s.id === nextStep(sim))!;
  const status = !sim.rotation.length && !field.plan ? "Needs a rotation" : sim.chosenId ? "Plan chosen" : rotationReady(sim.rotation.length ? sim.rotation : field.plan ? [field.plan] : []) ? "Rotation set" : "Rotation incomplete";
  return (
    <li className="db-card dash-card">
      <div className="dash-card-head">
        <h3 translate="no">{field.name}</h3>
        {farm.demo ? <span className="dash-tag">Demo</span> : null}
      </div>
      {/* A field in three lines: how big and where, what grows on it, and how far along its plan is. */}
      <p className="dash-meta">
        <span>{area.main}</span>
        {field.approx_shape ? <span className="mp-approx">Approximate shape</span> : null}
        <span translate={loc ? "no" : undefined}>{loc || (place?.place.state === "loading" ? "Looking up…" : coords)}</span>
      </p>
      {crops ? <p className="dash-crops">{crops}</p> : null}
      <div className="dash-next">
        <span className="dash-steps" role="img" aria-label={`Step ${step.n} of ${STEPS.length}. ${status}.`}>
          {STEPS.map((x) => (
            <i key={x.id} data-on={x.n < step.n || (step.id === "plan" && Boolean(sim.chosenId)) ? "done" : x.n === step.n ? "now" : "no"} />
          ))}
        </span>
        <a className="btn btn-primary" href={`?view=app#u=${step.id}`} onClick={() => selectField(field.field_id)} aria-label={`Continue ${field.name}: ${step.nav}`}>
          {step.id === "plan" ? "See your plan" : `Continue: ${step.nav}`}
        </a>
        <button type="button" className="btn btn-quiet dash-open" onClick={onOpen} aria-label={`Open ${field.name}`}>
          Field details
        </button>
      </div>
    </li>
  );
}
