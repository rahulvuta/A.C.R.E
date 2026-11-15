import { areaAc, areaHa } from "../../farm/geometry";
import { selectField } from "../../farm/hooks";
import { FarmMap } from "../../map/FarmMap";
import { Banner } from "../../ui/components";
import type { StepContext } from "./context";
import { useDemoLoader } from "./Guided";
import { num } from "./format";
import { pick, useTimelineModule } from "./slots";

/** Dev builds only: the Playwright specs move the map with `window.__map`. */
const exposeMapForTests = (m: unknown) => {
  if (import.meta.env.DEV) (window as unknown as { __map: unknown }).__map = m;
};

const DEMOS = [
  { id: "union" as const, name: "Union County, North Carolina", blurb: "Corn and soybean fields in the NC Piedmont, where NC State guidance applies." },
  { id: "pergamino" as const, name: "Pergamino, Buenos Aires", blurb: "Soybean, maize and wheat in the Argentine Pampas, with southern-hemisphere seasons." },
];

export function DemoPicker({ ctx }: { ctx: StepContext }) {
  const { demo, load } = useDemoLoader(ctx.api, () => ctx.go("now"));
  return (
    <section className="db-card gf-demo" aria-label="Try a demo farm">
      <div className="db-card-head">
        <h2>Try a demo farm</h2>
      </div>
      <p className="gf-muted">Every step comes filled in with example fields, plans, prices and readings, so you can see the whole simulator in a minute.</p>
      <div className="gf-demo-row">
        {DEMOS.map((d) => (
          <button key={d.id} type="button" className="gf-demo-btn" onClick={() => void load(d.id)} disabled={demo.state === "loading"}>
            <strong>{demo.state === "loading" && demo.which === d.id ? "Loading…" : d.name}</strong>
            <span>{d.blurb}</span>
          </button>
        ))}
      </div>
      {demo.state === "error" ? <Banner kind="error">{demo.message}</Banner> : null}
    </section>
  );
}

export function StepFarm({ ctx }: { ctx: StepContext }) {
  const { farm, field } = ctx;
  const timeline = useTimelineModule();
  const FieldCards = pick(timeline, "FieldCards");
  // Display-only measurements of the drawn outlines (turf); the service measures again for any result.
  const rows = (farm?.fields ?? []).map((f) => ({ f, ha: areaHa(f.geometry), ac: areaAc(f.geometry) }));
  const totalAc = rows.reduce((a, r) => a + r.ac, 0);
  const totalHa = rows.reduce((a, r) => a + r.ha, 0);
  return (
    <div className="gf-farm">
      <DemoPicker ctx={ctx} />
      <div className="ws-map gf-map">
        <FarmMap api={ctx.api.geo} onMapReady={exposeMapForTests} />
      </div>
      {farm && rows.length ? (
        FieldCards ? (
          <FieldCards farm={farm} selectedFieldId={field?.field_id ?? null} onSelect={(id: string) => selectField(id)} />
        ) : (
          <section className="db-card" aria-label="Your fields">
            <div className="db-card-head">
              <h2>{farm.name}</h2>
            </div>
            <ul className="gf-fields">
              {rows.map(({ f, ha, ac }) => (
                <li key={f.field_id}>
                  <button type="button" className="gf-field" aria-pressed={field?.field_id === f.field_id} onClick={() => selectField(f.field_id)}>
                    <strong>{f.name}</strong>
                    <span className="gf-acres">{num(ac, "acres", 1)}</span>
                    <span className="gf-muted">{num(ha, "ha", 1)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="gf-total">
              Farm area: <strong>{num(totalAc, "acres", 1)}</strong> <span className="gf-muted">({num(totalHa, "ha", 1)}, measured from your outlines)</span>
            </p>
          </section>
        )
      ) : null}
    </div>
  );
}
