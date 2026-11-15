import demoUnion from "../timeline/fixtures/demo-farm-union.json";
import { areaHa, checkGeometry } from "./geometry";
import type { Farm, Field, FieldPlan } from "./types";

/*
  The demo farm (contract §15, card U4). Asks the backend's `GET /v1/demo/farm` first; until
  that ships, or when it can't be reached, the labelled example file is used. Either way the
  farm is checked like an import (every outline must be valid) and is always called a demo.
*/
export type DemoScenario = "union" | "pergamino";

export interface DemoFarm {
  farm: Farm;
  label: string;
  /** "backend" when GET /v1/demo/farm answered; "example" for the bundled example file. */
  source: "backend" | "example";
  goals: unknown;
  economicsOverrides: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseDemoFarm(body: unknown, source: DemoFarm["source"]): DemoFarm | null {
  if (!isObj(body) || !isObj(body.farm) || !Array.isArray(body.farm.fields)) return null;
  const f = body.farm;
  const fields: Field[] = [];
  for (const x of f.fields as unknown[]) {
    if (!isObj(x) || typeof x.field_id !== "string" || checkGeometry(x.geometry) !== null) return null;
    const geometry = x.geometry as Field["geometry"];
    fields.push({
      field_id: x.field_id,
      name: typeof x.name === "string" ? x.name : "Field",
      geometry,
      display_area_ha: areaHa(geometry),
      plan: isObj(x.plan) ? (x.plan as unknown as FieldPlan) : null,
      ...(Array.isArray(x.equipment) ? { equipment: x.equipment.filter((e): e is string => typeof e === "string") } : {}),
      ...(Array.isArray(x.readings) ? { readings: x.readings.filter(isObj) as unknown as Field["readings"] } : {}),
    });
  }
  if (fields.length === 0) return null;
  const now = new Date().toISOString();
  const anchor = isObj(f.anchor) && typeof f.anchor.latitude === "number" && typeof f.anchor.longitude === "number" ? { latitude: f.anchor.latitude, longitude: f.anchor.longitude } : { latitude: 0, longitude: 0 };
  return {
    farm: {
      schema: "acre.farm.v1",
      farm_id: typeof f.farm_id === "string" ? f.farm_id : "farm_demo",
      name: typeof f.name === "string" ? f.name : "Demo farm",
      anchor,
      fields,
      created_at: typeof f.created_at === "string" ? f.created_at : now,
      updated_at: now,
    },
    label: typeof body.label === "string" ? body.label : "Demo farm (example values)",
    source,
    goals: body.goals ?? null,
    economicsOverrides: body.economics_overrides ?? null,
  };
}

const EXAMPLES: Partial<Record<DemoScenario, unknown>> = { union: demoUnion };

export async function loadDemoFarm(
  scenario: DemoScenario,
  fetchDemo?: (s: DemoScenario, signal?: AbortSignal) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>,
  signal?: AbortSignal,
): Promise<{ ok: true; demo: DemoFarm } | { ok: false; message: string }> {
  if (fetchDemo) {
    const r = await fetchDemo(scenario, signal).catch(() => null);
    const parsed = r && r.ok ? parseDemoFarm(r.data, "backend") : null;
    if (parsed) return { ok: true, demo: parsed };
  }
  const example = EXAMPLES[scenario];
  const parsed = example ? parseDemoFarm(example, "example") : null;
  return parsed ? { ok: true, demo: parsed } : { ok: false, message: "The demo farm could not be loaded. Is the A.C.R.E server running?" };
}
