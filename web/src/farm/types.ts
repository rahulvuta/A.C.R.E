/*
  Farm and field model (owner: Agent C; drafted in G0). D imports these types and never edits
  this file. Farms live only in the browser (localStorage key `acre.farms.v1`) and in GeoJSON
  exports; the backend never stores them. See docs/global/contract.md §5.
*/

/** GeoJSON geometry for one field: one or more parcels; inner rings are exclusions. */
export type FieldGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export type Origin =
  | "nasa_measured"
  | "nasa_modeled"
  | "calculation"
  | "verified_source"
  | "source_checked"
  | "ai_suggested"
  | "grower"
  | "assumed"
  | "dataset_estimate";

/** A field's plan, in the backend's plan shape (POST /v1/plans/compare `plans[]`). */
export interface FieldPlan {
  plan_id: string;
  label?: string;
  region?: string | null; // the backend fills this from the location; NC demo uses "NC Piedmont"
  production_system?: string | null;
  previous_crop_id: string;
  next_crop_id: string;
  prev_harvest: string; // MM-DD
  next_plant: string; // MM-DD
  winter:
    | { kind: "none" }
    | { kind: "cover"; crop_id: string; seed: string; terminate: string }
    | { kind: "winter_grain"; crop_id: string; plant: string; harvest: string };
  grower?: { low_moisture_concern?: boolean | null; residue_report?: string | null };
  /** Which parts of the plan the grower typed in, versus defaults taken from the profile. */
  origins?: Partial<Record<"crops" | "dates" | "winter", Origin>>;
}

export interface Field {
  field_id: string; // stable, e.g. "fld_" + random
  name: string;
  geometry: FieldGeometry;
  /** Display-only measurements made in the browser (turf). The backend recomputes them. */
  display_area_ha?: number;
  plan: FieldPlan | null;
  notes?: string;
}

export interface Farm {
  schema: "acre.farm.v1";
  farm_id: string;
  name: string;
  /** Where the map was centred when the farm was created; not sent anywhere on its own. */
  anchor: { latitude: number; longitude: number };
  fields: Field[];
  created_at: string; // ISO
  updated_at: string; // ISO
}

export interface FarmStore {
  schema: "acre.farms.v1";
  farms: Farm[];
  selected_farm_id: string | null;
  selected_field_id: string | null;
}
