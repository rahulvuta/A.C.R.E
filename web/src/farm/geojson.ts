import { areaHa, centroid, checkGeometry } from "./geometry";
import { newFarmId, newFieldId } from "./store";
import type { Farm, Field, FieldGeometry, FieldPlan } from "./types";

/*
  GeoJSON import and export (plan C2). Export is a FeatureCollection, one Feature per field
  with `field_id`, `name` and `plan` properties; the farm's name rides along as a foreign
  member. Geometry is written exactly as stored, so export → import round-trips it.
  Import is all or nothing: one bad feature rejects the file, with every problem listed.
*/
export interface FarmFeatureCollection {
  type: "FeatureCollection";
  acre: { schema: "acre.farm.v1"; farm_name: string };
  features: Array<{
    type: "Feature";
    geometry: FieldGeometry;
    properties: { field_id: string; name: string; plan: FieldPlan | null; notes?: string; approx_shape?: boolean };
  }>;
}

export function exportFarm(farm: Farm): FarmFeatureCollection {
  return {
    type: "FeatureCollection",
    acre: { schema: "acre.farm.v1", farm_name: farm.name },
    features: farm.fields.map((f) => ({
      type: "Feature",
      geometry: f.geometry,
      properties: { field_id: f.field_id, name: f.name, plan: f.plan, ...(f.notes ? { notes: f.notes } : {}), ...(f.approx_shape ? { approx_shape: true } : {}) },
    })),
  };
}

export function exportFileName(farm: Farm): string {
  const slug = farm.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "farm";
  return `${slug}.geojson`;
}

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_FIELDS = 500;

export type ImportResult = { ok: true; farm: Farm } | { ok: false; problems: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse a GeoJSON file into a new farm. Nothing is returned unless every feature is good. */
export function importFarm(text: string, fallbackName = "Imported farm"): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, problems: ["The file is larger than 5 MB."] };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["The file is not valid JSON."] };
  }
  // A single Feature or bare geometry is accepted as a one-field farm.
  if (isObj(body) && body.type === "Feature") body = { type: "FeatureCollection", features: [body] };
  else if (isObj(body) && (body.type === "Polygon" || body.type === "MultiPolygon")) body = { type: "FeatureCollection", features: [{ type: "Feature", geometry: body, properties: {} }] };
  if (!isObj(body) || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
    return { ok: false, problems: ["The file is not a GeoJSON FeatureCollection."] };
  }
  if (body.features.length === 0) return { ok: false, problems: ["The file has no fields in it."] };
  if (body.features.length > MAX_FIELDS) return { ok: false, problems: [`The file has more than ${MAX_FIELDS} fields.`] };

  const problems: string[] = [];
  const fields: Field[] = [];
  const seen = new Set<string>();
  body.features.forEach((feat, i) => {
    const label = `Feature ${i + 1}`;
    if (!isObj(feat) || feat.type !== "Feature") return void problems.push(`${label} is not a GeoJSON Feature.`);
    const props = isObj(feat.properties) ? feat.properties : {};
    const name = typeof props.name === "string" && props.name.trim() ? props.name.trim() : `Field ${i + 1}`;
    const problem = checkGeometry(feat.geometry);
    if (problem) return void problems.push(`${label} (${name}): ${problem.message}`);
    const id = typeof props.field_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(props.field_id) ? props.field_id : newFieldId();
    if (seen.has(id)) return void problems.push(`${label} (${name}): the field id "${id}" is used twice.`);
    seen.add(id);
    if (props.plan !== undefined && props.plan !== null && !isObj(props.plan)) return void problems.push(`${label} (${name}): the plan is not an object.`);
    const geometry = feat.geometry as FieldGeometry;
    fields.push({
      field_id: id,
      name,
      geometry,
      display_area_ha: areaHa(geometry),
      plan: isObj(props.plan) ? (props.plan as unknown as FieldPlan) : null,
      ...(typeof props.notes === "string" ? { notes: props.notes } : {}),
      ...(props.approx_shape === true ? { approx_shape: true } : {}),
    });
  });
  if (problems.length) return { ok: false, problems };

  const meta = isObj(body.acre) ? body.acre : {};
  const name = typeof meta.farm_name === "string" && meta.farm_name.trim() ? meta.farm_name.trim() : fallbackName;
  const now = new Date().toISOString();
  return {
    ok: true,
    farm: { schema: "acre.farm.v1", farm_id: newFarmId(), name, anchor: centroid(fields[0]!.geometry), fields, created_at: now, updated_at: now },
  };
}
