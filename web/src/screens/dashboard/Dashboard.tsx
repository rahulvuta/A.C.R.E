import { useEffect, useState } from "react";
import { APP_NAME } from "../../config";
import { farmActions, putFarm, selectField, useFarms } from "../../farm/hooks";
import { formatArea } from "../../farm/geometry";
import type { Farm, Field } from "../../farm/types";
import { FarmMap } from "../../map/FarmMap";
import { useFieldPlace } from "../../state/useFieldPlace";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { getSimField, loadDemoFields, removeSimField, updateSimField, useSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { SourceBanner } from "../workspace/Workspace";
import { cropsOf, rotationReady } from "../guided/context";
import { cropLabel } from "../guided/format";
import { FieldWorkspace } from "./FieldWorkspace";

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
  const { farms, notice } = useFarms();
  const [route, go] = useRoute();
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

  return (
    <div className="dash">
      <header className="dash-top">
        <a className="db-brand dash-brand" href="?" aria-label={`${APP_NAME} dashboard`}>
          <span className="fb-mark" aria-hidden="true" />
          {APP_NAME}
        </a>
        <nav className="dash-nav" aria-label="Main">
          <button type="button" aria-current={route.page === "fields" ? "page" : undefined} onClick={() => go({ page: "fields" })}>
            Fields
          </button>
          <a href="?view=app">Guided simulator</a>
          <a href="?view=methods">How it works</a>
          <a href="?view=privacy">Privacy</a>
          <a href="?view=home">About</a>
        </nav>
        <button type="button" className="btn btn-primary" onClick={startAdd}>
          Add field
        </button>
      </header>
      <main className="dash-main">
        <SourceBanner source={api.source} />
        {notice ? <Banner kind="info">{notice}</Banner> : null}
        {route.page === "add" ? (
          <section aria-label="Add a field">
            <div className="dash-bar">
              <div>
                <h1>Add a field</h1>
                <p className="dash-muted">Find your farm, draw the boundary, name the field. Acreage is measured as you draw.</p>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => go({ page: "fields" })}>
                Done, back to fields
              </button>
            </div>
            <div className="ws-map">
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
            <div className="dash-bar">
              <h1>Fields</h1>
            </div>
            {myFields.length === 0 ? (
              <section className="dash-empty" aria-label="No fields">
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
            <section className="dash-demos" aria-label="Demo farms">
              <div className="dash-bar">
                <h2>Demo farms</h2>
                <span className="dash-muted">Examples with sample values, kept apart from your own fields.</span>
              </div>
              {demoFields.length ? (
                <ul className="dash-grid" aria-label="Demo fields">
                  {demoFields.map(({ farm, field }) => (
                    <FieldCard key={field.field_id} api={api} farm={farm} field={field} onOpen={() => open(field.field_id)} />
                  ))}
                </ul>
              ) : null}
              <div className="dash-demo-row">
                {DEMOS.map((d) => {
                  const loaded = demos.some((f) => f.demo && f.name.toLowerCase().includes(d.id === "union" ? "union" : "pergamino"));
                  return (
                    <button key={d.id} type="button" className="dash-demo-btn" onClick={() => void loadDemo(d.id)} disabled={demo.state === "loading"}>
                      <strong>{demo.state === "loading" && demo.which === d.id ? "Loading…" : d.name}</strong>
                      <span>{d.blurb}</span>
                      <span className="dash-muted">{loaded ? "Load again (resets its example values)" : "Explore this demo farm"}</span>
                    </button>
                  );
                })}
              </div>
              {demo.state === "error" ? <Banner kind="error">{demo.message}</Banner> : null}
              {demos.length ? (
                <button type="button" className="btn btn-quiet" onClick={() => demos.forEach((f) => (f.fields.forEach((x) => removeSimField(x.field_id)), farmActions.deleteFarm(f.farm_id)))}>
                  Remove demo farms
                </button>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function FieldCard({ api, farm, field, onOpen }: { api: GlobalApi; farm: Farm; field: Field; onOpen: () => void }) {
  const sim = useSimField(field.field_id);
  const place = useFieldPlace(api.client, field);
  const area = formatArea(field.geometry);
  const loc = place?.place.state === "ready" ? [place.place.data.admin2Name, place.place.data.admin1Name, place.place.data.countryName].filter(Boolean).join(", ") : "";
  const crops = sim.rotation.length ? cropsOf(sim.rotation).map(cropLabel).join(" → ") : field.plan ? cropsOf([field.plan]).map(cropLabel).join(" → ") : "";
  const status = !sim.rotation.length && !field.plan ? "Needs a rotation" : sim.chosenId ? "Plan chosen" : rotationReady(sim.rotation.length ? sim.rotation : field.plan ? [field.plan] : []) ? "Rotation set" : "Rotation incomplete";
  return (
    <li className="dash-card">
      <div className="dash-card-head">
        <h3>{field.name}</h3>
        {farm.demo ? <span className="dash-tag">Demo</span> : null}
      </div>
      <dl>
        <div><dt>Acreage</dt><dd>{area.ac} <span className="dash-muted">({area.ha})</span></dd></div>
        <div><dt>Location</dt><dd>{loc || (place?.place.state === "loading" ? "Looking up…" : farm.name)}</dd></div>
        <div><dt>Crop rotation</dt><dd>{crops || "Not set"}</dd></div>
        <div><dt>Planning status</dt><dd>{status}</dd></div>
      </dl>
      <button type="button" className="btn btn-secondary" onClick={onOpen} aria-label={`Open ${field.name}`}>
        Open field
      </button>
    </li>
  );
}
