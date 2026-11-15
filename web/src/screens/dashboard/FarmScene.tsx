import { useMemo } from "react";
import type { Plan } from "../../api/schema";
import type { CardKey } from "../../content/strategies";
import { centroid } from "../../farm/geometry";
import type { Farm, FieldPlan } from "../../farm/types";
import { farmLayout, SCENE_SHAPE_LABEL } from "../../scene/polygonShape";
import { getSimField } from "../../state/simField";
import type { StripVM } from "../../view/build";
import { FarmView } from "../planner/FarmView";

/*
  The farm in 3D for the field workspace: every field of this farm drawn with its drawn shape,
  at its real size and place relative to the others (one shared scale), growing the first
  season of that field's own rotation. Reuses the deep-dive's FarmView/FarmWorld stage.

  An illustration of planned dates only: no weather is passed in, so there is no modeled soil
  water or replayed rain here (that stays in Simulation), and nothing is measured from it.
*/

// The stage the deep-dive's three square fields occupy (FarmWorld's FIELD_W = 7.4, GAP = 1.1),
// so the camera framing and per-field plant spacing stay as designed.
const FIELD = 7.4;
const STAGE_W = 3 * FIELD + 2 * 1.1;
const STAGE_D = FIELD * 1.5;

const NO_WEATHER: StripVM["weather"] = { year: null, complete: false, totalMm: null, medianMm: null, wetness: null, wetnessRange: null };

// The stage runs September to June (a northern winter). A southern-hemisphere field's dates
// are moved six months so its own winter lands on the same stage; the timeline months are then
// read six months on (Sep reads as Mar), which the caption says.
function shiftMd(md: string): string {
  const [m, d] = md.split("-").map(Number) as [number, number];
  const month = ((m + 5) % 12) + 1;
  const last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return `${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

// The stage draws corn, soybean, winter grain and cover plants; maize is drawn as corn.
const drawn = (id: string) => (id === "maize" ? "field_corn" : id);

function scenePlan(p: FieldPlan, south: boolean): Plan | null {
  if (!p.previous_crop_id || !p.next_crop_id || !p.prev_harvest || !p.next_plant) return null;
  const md = (x: string) => (south ? shiftMd(x) : x);
  const w = p.winter;
  const winter =
    w.kind === "cover"
      ? { type: "cover" as const, crop_id: w.crop_id, seed: md(w.seed), terminate: md(w.terminate) }
      : w.kind === "winter_grain"
        ? { type: "winter_grain" as const, crop_id: w.crop_id, plant: md(w.plant), harvest: md(w.harvest) }
        : { type: "none" as const };
  if (winter.type === "cover" && !(winter.seed && winter.terminate)) return null;
  if (winter.type === "winter_grain" && !(winter.plant && winter.harvest)) return null;
  return {
    plan_id: p.plan_id,
    label: p.label ?? p.plan_id,
    sequence: { previous_crop_id: drawn(p.previous_crop_id), prev_harvest: md(p.prev_harvest), winter, next_crop_id: drawn(p.next_crop_id), next_plant: md(p.next_plant) },
    spring_checks: [],
    other_checks: [],
    eras: {},
  };
}

export function FarmScene({ farm, fieldId, rotation, onOpen }: { farm: Farm; fieldId: string; rotation: FieldPlan[]; onOpen: (fieldId: string) => void }) {
  const fields = farm.fields;
  const layout = useMemo(() => farmLayout(fields.map((f) => f.geometry), STAGE_W, STAGE_D, FIELD), [fields]);
  const south = fields.some((f) => centroid(f.geometry).latitude < 0);
  const strips: StripVM[] = fields.map((f) => {
    // The open field uses its live rotation; the others read their saved one.
    const rot = f.field_id === fieldId ? rotation : getSimField(f.field_id).rotation;
    const first = rot[0] ?? f.plan;
    return {
      // FarmWorld keys and reports clicks by strip key; here the key is the field id.
      key: f.field_id as CardKey,
      name: f.name,
      plan: first ? scenePlan(first, centroid(f.geometry).latitude < 0) : null,
      selected: f.field_id === fieldId,
      status: null,
      weather: NO_WEATHER,
    };
  });
  if (!layout) return null;
  return (
    <section className="db-card db-fields fb-stage-wrap" aria-label="Farm in 3D">
      <header className="db-card-head">
        <div>
          <h2>{farm.name} in 3D</h2>
          <p className="gf-muted">
            Each field at its drawn shape and place on the farm, growing the first season of its own rotation. Click a field to open it. A field without a complete rotation is
            shown as a pale slab.{south ? " Southern-hemisphere dates are shifted six months onto this September–June stage (read Sep as Mar)." : ""}
          </p>
        </div>
      </header>
      <FarmView
        strips={strips}
        layout={layout}
        spring={null}
        tag={SCENE_SHAPE_LABEL}
        waterKey={false}
        onSelectCard={(k) => {
          if (k !== fieldId) onOpen(k);
        }}
        onSpring={() => {}}
      />
    </section>
  );
}
