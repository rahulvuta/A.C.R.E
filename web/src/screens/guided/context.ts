import type { SimulateRequest } from "../../api/adapt";
import type { LatLon, RegionProfile } from "../../api/model";
import type { Scenario } from "../../api/simModel";
import { areaHa } from "../../farm/geometry";
import type { Farm, Field, FieldPlan } from "../../farm/types";
import type { GlobalApi } from "../../state/useGlobal";
import { baselineOf, type SimField } from "../../state/simField";
import type { StepId } from "./steps";

/** What every step reads: the API, the selected farm and field, and that field's simulator state. */
export interface StepContext {
  api: GlobalApi;
  farm: Farm | null;
  field: Field | null;
  sim: SimField;
  point: LatLon | null;
  regionKey: string | null;
  profile: RegionProfile | null;
  go: (s: StepId) => void;
}

export const planReady = (p: FieldPlan) =>
  Boolean(p.previous_crop_id && p.next_crop_id && /^\d{2}-\d{2}$/.test(p.prev_harvest) && /^\d{2}-\d{2}$/.test(p.next_plant)) &&
  (p.winter.kind === "none" ||
    (p.winter.kind === "cover" ? Boolean(p.winter.crop_id && p.winter.seed && p.winter.terminate) : Boolean(p.winter.crop_id && p.winter.plant && p.winter.harvest)));
export const rotationReady = (r: FieldPlan[]) => r.length > 0 && r.every(planReady);

/** The crops a rotation uses (for economics), in order of first use. */
export function cropsOf(r: FieldPlan[]): string[] {
  const out: string[] = [];
  for (const p of r) for (const c of [p.previous_crop_id, p.winter.kind !== "none" ? p.winter.crop_id : "", p.next_crop_id]) if (c && !out.includes(c)) out.push(c);
  return out;
}

/** The simulate request for this field: the baseline plus the given alternatives. */
export function simulateRequest(ctx: Pick<StepContext, "field" | "sim" | "point">, alternatives: Scenario[]): SimulateRequest | null {
  const { field, sim, point } = ctx;
  if (!field || !point || !rotationReady(sim.rotation)) return null;
  const ha = areaHa(field.geometry);
  return {
    point,
    field: { fieldId: field.field_id, name: field.name, areaHa: ha > 0 ? Math.round(ha * 100) / 100 : null, geometry: field.geometry, equipment: sim.equipment, readings: sim.readings },
    priorities: sim.priorities,
    overrides: sim.overrides,
    loss: sim.loss,
    scenarios: [baselineOf(sim), ...alternatives.filter((s) => rotationReady(s.rotation))],
    startSeason: sim.startSeason,
  };
}
