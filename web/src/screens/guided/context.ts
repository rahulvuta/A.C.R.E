import { MAX_ROTATION_LEGS } from "../../api/limits";
import { economicsReady } from "./inputState";
import type { SimulateRequest } from "../../api/adapt";
import type { LatLon, RegionProfile } from "../../api/model";
import type { Scenario } from "../../api/simModel";
import { areaHa } from "../../farm/geometry";
import type { Farm, Field, FieldPlan } from "../../farm/types";
import type { GlobalApi } from "../../state/useGlobal";
import { baselineOf, zonesOf, type SimField } from "../../state/simField";
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
  active?: boolean;
  go: (s: StepId) => void;
}

export const planReady = (p: FieldPlan) =>
  Boolean(p.previous_crop_id && p.next_crop_id && /^\d{2}-\d{2}$/.test(p.prev_harvest) && /^\d{2}-\d{2}$/.test(p.next_plant)) &&
  (p.winter.kind === "none" ||
    (p.winter.kind === "cover" ? Boolean(p.winter.crop_id && p.winter.seed && p.winter.terminate) : Boolean(p.winter.crop_id && p.winter.plant && p.winter.harvest)));
/** Zones are usable when there are at least two, each with a share, and the shares add up to the whole field. */
export const zonesOk = (zones: SimField["zones"]) => {
  const z = zones ?? [];
  return z.length >= 2 && z.every((x) => x.share > 0) && Math.abs(z.reduce((a, x) => a + x.share, 0) - 1) <= 0.01 && new Set(z.map((x) => x.zoneId)).size === z.length;
};
export const rotationReady = (r: FieldPlan[]) => r.length > 0 && r.length <= MAX_ROTATION_LEGS && r.every(planReady);

/** The current plan is complete: the field's rotation, or every zone's rotation when the field has zones. */
export const baselineReady = (sim: SimField) => (zonesOf(sim).length > 0 ? zonesOk(sim.zones) && sim.zones!.every((z) => rotationReady(sim.zoneRotations?.[z.zoneId] ?? [])) : rotationReady(sim.rotation));
/** Every crop the current plan uses, over all zones. */
export const simCrops = (sim: SimField): string[] => cropsOf(zonesOf(sim).length > 0 ? sim.zones!.flatMap((z) => sim.zoneRotations?.[z.zoneId] ?? []) : sim.rotation);

/** The crops a rotation uses (for economics), in order of first use. */
export function cropsOf(r: FieldPlan[]): string[] {
  const out: string[] = [];
  for (const p of r) for (const c of [p.previous_crop_id, p.winter.kind !== "none" ? p.winter.crop_id : "", p.next_crop_id]) if (c && !out.includes(c)) out.push(c);
  return out;
}

/** The simulate request for this field: the baseline plus the given alternatives. */
export function simulateRequest(ctx: Pick<StepContext, "field" | "sim" | "point"> & Partial<Pick<StepContext, "regionKey">>, alternatives: Scenario[]): SimulateRequest | null {
  const { field, sim, point } = ctx;
  if (!field || !point || !baselineReady(sim) || !economicsReady(sim)) return null;
  const ha = areaHa(field.geometry);
  return {
    point,
    regionKey: ctx.regionKey,
    field: { fieldId: field.field_id, name: field.name, areaHa: ha > 0 ? Math.round(ha * 100) / 100 : null, geometry: field.geometry, equipment: sim.equipment, readings: sim.readings, ...(zonesOf(sim).length ? { zones: sim.zones!.map((z) => ({ zoneId: z.zoneId, name: z.name, share: z.share })) } : {}) },
    priorities: sim.priorities,
    overrides: sim.overrides,
    loss: sim.loss,
    scenarios: [baselineOf(sim), ...alternatives.filter((s) => rotationReady(s.rotation))],
    startSeason: sim.startSeason,
  };
}
