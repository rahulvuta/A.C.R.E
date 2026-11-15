import { useEffect, useState } from "react";
import { APP_NAME } from "../../config";
import { farmActions, putFarm, selectField, useFarms } from "../../farm/hooks";
import { centroid, formatArea } from "../../farm/geometry";
import type { Farm, Field } from "../../farm/types";
import { FarmMap } from "../../map/FarmMap";
import { useFieldPlace } from "../../state/useFieldPlace";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { getSimField, loadDemoFields, removeSimField, updateSimField, useSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { SourceBanner } from "../workspace/Workspace";
import { cropsOf, rotationReady } from "../guided/context";
import { cropLabel } from "../guided/format";
import { FieldWorkspace, TABS } from "./FieldWorkspace";
import { navIcon } from "../planner/SideNav";
import { DEEP_DIVE_HREF } from "../guided/Guided";

/*
  The front door of the app: an empty farm dashboard. Fields are cards; "Add field" opens the
  existing map editor (FarmMap); a field opens its own workspace. Demo farms are loaded only
  on request, are flagged (`farm.demo`) and listed apart from the grower's own fields; a demo
  field can be copied into the grower's fields. Everything stays in this browser.
*/
type Route = { page: "fields" } | { page: "add" } | { page: "field"; id: string; tab: string };

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
  { id: "union" as const, name: "Union County, North Carolina", blurb: "Corn and soybean fields in the NC Piedmont." },
  { id: "pergamino" as const, name: "Pergamino, Buenos Aires", blurb: "Soybean, maize and wheat in the Argentine Pampas." },
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
    go({ page: "add" });
  };

  const fieldId = route.page === "field" ? route.id : null;
  const current = fieldId ? farms.flatMap((f) => f.fields.map((x) => ({ farm: f, field: x }))).find((x) => x.field.field_id === fieldId) : null;

  const title = route.page === "add" ? "Add a field" : current ? current.field.name : "Fields";
  const onFieldPage = route.page === "field" && current;
  const activeTab = route.page === "field" ? route.tab : "";

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
              <button type="button" aria-current={route.page === "fields" ? "step" : undefined} onClick={() => go({ page: "fields" })}>
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
        {onFieldPage ? (
          <nav className="gf-steps dash-sections" aria-label="Field sections">
            <p className="dash-side-label">{current.field.name}</p>
            <div role="tablist" aria-label="Field sections" aria-orientation="vertical">
              {TABS.map((t, i) => (
                <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={activeTab === t.id} aria-current={activeTab === t.id ? "step" : undefined} aria-controls={`pane-${t.id}`} onClick={() => go({ page: "field", id: current.field.field_id, tab: t.id })}>
                  <span className="gf-dot" aria-hidden="true">{i + 1}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </nav>
        ) : null}
        <div className="db-side-foot">
          <div className="db-links">
            <a href="?view=app">{navIcon("M4 4h10M4 9h10M4 14h6")}Guided simulator</a>
            <a href={DEEP_DIVE_HREF}>{navIcon("M3 8l6-5 6 5v7H3zM7.500 15v-4h3v4")}Union County deep-dive</a>
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
            <h1>{title}</h1>
            {onFieldPage ? <span className="dash-muted">{formatArea(current.field.geometry).ac}</span> : null}
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
          {notice ? <Banner kind="info">{notice}</Banner> : null}
          {route.page === "add" ? (
            <section aria-label="Add a field" className="gf-farm">
              <header className="gf-head">
                <h2 className="gf-question">Where is your field?</h2>
                <p className="gf-sentence">Find your farm on the map, draw the boundary and name the field. Acres show as soon as you finish the shape.</p>
              </header>
              <div className="ws-map gf-map">
                <FarmMap api={api.geo} />
              </div>
            </section>
          ) : null}
          {route.page === "field" ? (
            current ? (
              <FieldWorkspace key={current.field.field_id} api={api} farm={current.farm} field={current.field} tab={route.tab} onTab={(tab) => go({ page: "field", id: current.field.field_id, tab })} onClose={() => go({ page: "fields" })} onCopy={() => { const id = copyToMyFields(current.farm, current.field, mine[0] ?? null); open(id); }} />
            ) : (
              <Banner kind="info">
                That field is not saved in this browser. <button type="button" className="btn btn-quiet" onClick={() => go({ page: "fields" })}>Back to fields</button>
              </Banner>
            )
          ) : null}
          {route.page === "fields" ? (
            <>
              <header className="gf-head">
                <h2 className="gf-question">Your fields</h2>
                <p className="gf-sentence">Each field keeps its own rotation, dates, money entries and simulations, saved in this browser. No account needed.</p>
              </header>
              {myFields.length === 0 ? (
                <section className="db-card dash-empty" aria-label="No fields">
                  <h2>No fields available</h2>
                  <p>Add a field to begin managing your farm, planning crop rotations, and analyzing agricultural conditions.</p>
                  <div className="dash-actions">
                    <button type="button" className="btn btn-primary btn-large" onClick={startAdd}>
                      Add Field
                    </button>
                    {demos.length === 0 ? (
                      <button type="button" className="btn btn-secondary btn-large" onClick={() => void loadDemo("union")} disabled={demo.state === "loading"}>
                        {demo.state === "loading" ? "Loading demo…" : "Explore Demo Farm"}
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : (
                <ul className="dash-grid" aria-label="Your fields">
                  {myFields.map(({ farm, field }) => (
                    <FieldCard key={field.field_id} api={api} farm={farm} field={field} onOpen={() => open(field.field_id)} />
                  ))}
                </ul>
              )}
              <section className="db-card gf-demo dash-demos" aria-label="Demo farms">
                <div className="db-card-head">
                  <h2>Try a demo farm</h2>
                </div>
                <p className="gf-muted">Example fields with sample plans, prices and readings, kept apart from your own fields. Copy a demo field to make it yours.</p>
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
                        <span>{loaded ? "Load again (resets its example values)" : "Explore this demo farm"}</span>
                      </button>
                    );
                  })}
                </div>
                {demo.state === "error" ? <Banner kind="error">{demo.message}</Banner> : null}
                {demos.length ? (
                  <div>
                    <button type="button" className="btn btn-quiet" onClick={() => demos.forEach((f) => (f.fields.forEach((x) => removeSimField(x.field_id)), farmActions.deleteFarm(f.farm_id)))}>
                      Remove demo farms
                    </button>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function FieldCard({ api, farm, field, onOpen }: { api: GlobalApi; farm: Farm; field: Field; onOpen: () => void }) {
  const sim = useSimField(field.field_id);
  const place = useFieldPlace(api.client, field);
  const area = formatArea(field.geometry);
  const loc = place?.place.state === "ready" ? [place.place.data.admin2Name, place.place.data.admin1Name, place.place.data.countryName].filter(Boolean).join(", ") : "";
  const c = centroid(field.geometry);
  const coords = `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)}`;
  const crops = sim.rotation.length ? cropsOf(sim.rotation).map(cropLabel).join(" → ") : field.plan ? cropsOf([field.plan]).map(cropLabel).join(" → ") : "";
  const status = !sim.rotation.length && !field.plan ? "Needs a rotation" : sim.chosenId ? "Plan chosen" : rotationReady(sim.rotation.length ? sim.rotation : field.plan ? [field.plan] : []) ? "Rotation set" : "Rotation incomplete";
  return (
    <li className="db-card dash-card">
      <div className="dash-card-head">
        <h3>{field.name}</h3>
        {farm.demo ? <span className="dash-tag">Demo</span> : null}
      </div>
      <dl>
        <div><dt>Acreage</dt><dd>{area.ac} <span className="dash-muted">({area.ha})</span></dd></div>
        <div><dt>Location</dt><dd>{loc || (place?.place.state === "loading" ? "Looking up…" : coords)}</dd></div>
        <div><dt>Crop rotation</dt><dd>{crops || "Not set"}</dd></div>
        <div><dt>Planning status</dt><dd>{status}</dd></div>
      </dl>
      <button type="button" className="btn btn-secondary" onClick={onOpen} aria-label={`Open ${field.name}`}>
        Open field
      </button>
    </li>
  );
}
