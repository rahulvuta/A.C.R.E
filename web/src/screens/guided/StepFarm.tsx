import { FarmMap } from "../../map/FarmMap";
import { Banner } from "../../ui/components";
import type { StepContext } from "./context";
import { useDemoLoader } from "./Guided";

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
  // The map panel (C, U4) lists each field with its acres and the farm's area total.
  return (
    <div className="gf-farm">
      <DemoPicker ctx={ctx} />
      <div className="ws-map gf-map">
        <FarmMap api={ctx.api.geo} onMapReady={exposeMapForTests} />
      </div>
    </div>
  );
}
