import { useFarms } from "../../farm/hooks";
import { FarmMap } from "../../map/FarmMap";
import { Banner } from "../../ui/components";
import type { StepContext } from "./context";
import { useDemoLoader } from "./Guided";

/** Dev builds only: the Playwright specs move the map with `window.__map`. */
const exposeMapForTests = (m: unknown) => {
  if (import.meta.env.DEV) (window as unknown as { __map: unknown }).__map = m;
};

const DEMOS = [
  { id: "union" as const, name: "United States: Union County, North Carolina", blurb: "Maize and soybean fields, with a winter between the crops." },
  { id: "pergamino" as const, name: "Argentina: Pergamino, Buenos Aires", blurb: "Soybean, maize and wheat, with southern-hemisphere seasons." },
];

export function DemoPicker({ ctx }: { ctx: StepContext }) {
  const { demo, load } = useDemoLoader(ctx.api, () => ctx.go("now"));
  const { farms } = useFarms();
  // A grower who has a field of their own is past the examples: other countries' farms are not put in front of them (card 23).
  if (farms.some((f) => !f.demo && f.fields.length > 0)) return null;
  return (
    <section className="db-card gf-demo gf-demo-slim" aria-label="Try an example farm">
      <h2>Try an example farm</h2>
      <div className="gf-demo-row">
        {DEMOS.map((d) => (
          <button key={d.id} type="button" className="gf-demo-btn" title={d.blurb} onClick={() => void load(d.id)} disabled={demo.state === "loading"}>
            <strong>{demo.state === "loading" && demo.which === d.id ? "Loading…" : d.name}</strong>
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
      <ol className="gf-howto" aria-label="How to add your field">
        <li>Search for your town or village</li>
        <li>Press Draw my field here and click each corner</li>
        <li>Or type the field's size and skip the drawing</li>
      </ol>
      <DemoPicker ctx={ctx} />
      <div className="ws-map gf-map">
        <FarmMap api={ctx.api.geo} onMapReady={exposeMapForTests} drawOnPick />
      </div>
    </div>
  );
}
