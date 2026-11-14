import { bandFill, cropName } from "./crops";
import type { Band } from "./schedule";

/** One stretch of bands with planting and harvest marks; `span` places it inside a wider track. */
export function Track({ bands, labels = true, span = [0, 1] }: { bands: Band[]; labels?: boolean; span?: [number, number] }) {
  const [a, b] = span;
  const at = (f: number) => `${(a + f * (b - a)) * 100}%`;
  const width = (x: Band) => `${(x.to - x.from) * (b - a) * 100}%`;
  return (
    <>
      {bands.map((x, i) => (
        <div
          key={i}
          className="tl-band"
          data-kind={x.kind}
          data-crop={x.crop ?? ""}
          style={{ left: at(x.from), width: width(x), background: bandFill(x.kind, x.crop) }}
        >
          {labels && (x.to - x.from) * (b - a) > 0.11 ? <span className="tl-band-label">{x.kind === "fallow" ? "Bare" : cropName(x.crop)}</span> : null}
        </div>
      ))}
      {bands.map((x, i) => (
        <span key={`m${i}`}>
          {x.startMark ? <span className="tl-mark tl-mark-start" data-mark={x.startMark} style={{ left: at(x.from) }} aria-hidden="true" /> : null}
          {x.endMark ? <span className="tl-mark tl-mark-end" data-mark={x.endMark} style={{ left: at(x.to) }} aria-hidden="true" /> : null}
        </span>
      ))}
    </>
  );
}

export function Legend({ risk }: { risk: number }) {
  return (
    <ul className="tl-legend" aria-label="Timeline key">
      <li>
        <span className="tl-swatch" data-kind="cash" aria-hidden="true" />
        Cash crop
      </li>
      <li>
        <span className="tl-swatch" data-kind="cover" aria-hidden="true" />
        Cover crop
      </li>
      <li>
        <span className="tl-swatch" data-kind="fallow" aria-hidden="true" />
        Bare ground
      </li>
      <li>
        <span className="tl-key-mark tl-mark-start" aria-hidden="true" />
        Planted or seeded
      </li>
      <li>
        <span className="tl-key-mark tl-mark-end" aria-hidden="true" />
        Harvested or ended
      </li>
      <li>
        <span className="tl-risk" aria-hidden="true" />
        Weather risk in {Math.round(risk * 100)}% or more of replays
      </li>
    </ul>
  );
}
