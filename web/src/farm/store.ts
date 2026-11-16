import { areaHa, checkGeometry } from "./geometry";
import type { Farm, FarmStore, Field, FieldGeometry, FieldPlan, FieldReading } from "./types";

/*
  The farm store (plan C2). Farms live only in this browser: localStorage key
  `acre.farms.v1`, versioned, with a memory fallback when storage is blocked or full.
  Nothing here is sent anywhere or logged. Writes are validated so a bad shape never lands.
*/
export const STORAGE_KEY = "acre.farms.v1";
export const BACKUP_KEY = "acre.farms.v1.unreadable";

export type Persistence = "local" | "memory";

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export const emptyStore = (): FarmStore => ({ schema: "acre.farms.v1", farms: [], selected_farm_id: null, selected_field_id: null });

const rid = (prefix: string) => {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};
export const newFarmId = () => rid("farm_");
export const newFieldId = () => rid("fld_");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Turn whatever is stored into a valid store; fields with bad shapes are dropped, never half-kept. */
export function migrate(raw: unknown): { store: FarmStore; dropped: number } | null {
  // v0 (never shipped, but cheap to accept): a bare array of farms.
  const body = Array.isArray(raw) ? { schema: "acre.farms.v1", farms: raw, selected_farm_id: null, selected_field_id: null } : raw;
  if (!isObj(body) || body.schema !== "acre.farms.v1" || !Array.isArray(body.farms)) return null;
  let dropped = 0;
  const farms: Farm[] = [];
  for (const f of body.farms) {
    if (!isObj(f) || typeof f.farm_id !== "string" || !Array.isArray(f.fields)) {
      dropped++;
      continue;
    }
    const fields: Field[] = [];
    for (const fl of f.fields) {
      if (!isObj(fl) || typeof fl.field_id !== "string" || checkGeometry(fl.geometry) !== null) {
        dropped++;
        continue;
      }
      fields.push({
        field_id: fl.field_id,
        name: typeof fl.name === "string" ? fl.name : "Field",
        geometry: fl.geometry as FieldGeometry,
        display_area_ha: areaHa(fl.geometry as FieldGeometry),
        plan: isObj(fl.plan) ? (fl.plan as unknown as FieldPlan) : null,
        ...(typeof fl.notes === "string" ? { notes: fl.notes } : {}),
        ...(fl.approx_shape === true ? { approx_shape: true as const } : {}),
        ...(Array.isArray(fl.equipment) ? { equipment: fl.equipment.filter((x): x is string => typeof x === "string") } : {}),
        ...(Array.isArray(fl.readings) ? { readings: fl.readings.filter(isObj) as unknown as FieldReading[] } : {}),
      });
    }
    const anchor = isObj(f.anchor) && typeof f.anchor.latitude === "number" && typeof f.anchor.longitude === "number" ? { latitude: f.anchor.latitude, longitude: f.anchor.longitude } : { latitude: 0, longitude: 0 };
    const now = new Date().toISOString();
    farms.push({
      schema: "acre.farm.v1",
      farm_id: f.farm_id,
      name: typeof f.name === "string" ? f.name : "My farm",
      anchor,
      fields,
      ...(typeof f.demo === "string" ? { demo: f.demo } : {}),
      created_at: typeof f.created_at === "string" ? f.created_at : now,
      updated_at: typeof f.updated_at === "string" ? f.updated_at : now,
    });
  }
  const selFarm = typeof body.selected_farm_id === "string" && farms.some((f) => f.farm_id === body.selected_farm_id) ? body.selected_farm_id : (farms[0]?.farm_id ?? null);
  const farm = farms.find((f) => f.farm_id === selFarm);
  const selField = typeof body.selected_field_id === "string" && farm?.fields.some((x) => x.field_id === body.selected_field_id) ? body.selected_field_id : null;
  return { store: { schema: "acre.farms.v1", farms, selected_farm_id: selFarm, selected_field_id: selField }, dropped };
}

export interface FarmStoreHandle {
  get(): FarmStore;
  persistence(): Persistence;
  /** A plain sentence when something was wrong with what was stored, else null. */
  notice(): string | null;
  subscribe(fn: () => void): () => void;
  set(next: FarmStore): void;
}

export function createFarmStore(storage: StorageLike | null): FarmStoreHandle {
  let persistence: Persistence = storage ? "local" : "memory";
  let notice: string | null = storage ? null : "This browser is not saving farms; they will be lost when the page closes. Export them as GeoJSON to keep them.";
  let state = emptyStore();
  if (storage) {
    try {
      const text = storage.getItem(STORAGE_KEY);
      if (text) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const m = migrate(parsed);
        if (m) {
          state = m.store;
          if (m.dropped) notice = `${m.dropped} saved ${m.dropped === 1 ? "item was" : "items were"} unreadable and left out.`;
        } else {
          // Keep the unreadable copy so nothing is lost silently.
          try {
            storage.setItem(BACKUP_KEY, text);
          } catch {
            /* nothing more to do */
          }
          notice = "Saved farms could not be read. A copy was kept, and a fresh list was started.";
        }
      }
    } catch {
      persistence = "memory";
      notice = "This browser is not saving farms; they will be lost when the page closes. Export them as GeoJSON to keep them.";
    }
  }
  const subs = new Set<() => void>();
  return {
    get: () => state,
    persistence: () => persistence,
    notice: () => notice,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    set(next) {
      state = next;
      if (storage && persistence === "local") {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          persistence = "memory";
          notice = "This browser stopped saving farms (storage is full or blocked). Export them as GeoJSON to keep them.";
        }
      }
      subs.forEach((fn) => fn());
    },
  };
}

// ------------------------------------------------------------------ pure updates

const touch = (f: Farm): Farm => ({ ...f, updated_at: new Date().toISOString() });

function mapFarm(s: FarmStore, farmId: string, fn: (f: Farm) => Farm): FarmStore {
  return { ...s, farms: s.farms.map((f) => (f.farm_id === farmId ? touch(fn(f)) : f)) };
}

function farmOfField(s: FarmStore, fieldId: string): Farm | undefined {
  return s.farms.find((f) => f.fields.some((x) => x.field_id === fieldId));
}

export const ops = {
  createFarm(s: FarmStore, name: string, anchor: { latitude: number; longitude: number }): { store: FarmStore; farm: Farm } {
    const now = new Date().toISOString();
    const farm: Farm = { schema: "acre.farm.v1", farm_id: newFarmId(), name: name.trim() || "My farm", anchor, fields: [], created_at: now, updated_at: now };
    return { farm, store: { ...s, farms: [...s.farms, farm], selected_farm_id: farm.farm_id, selected_field_id: null } };
  },
  /** Add a farm (e.g. imported). Field ids already used by another saved farm get new ids. */
  addFarm(s: FarmStore, farm: Farm): FarmStore {
    const used = new Set(s.farms.flatMap((f) => f.fields.map((x) => x.field_id)));
    const fields = farm.fields.map((x) => (used.has(x.field_id) ? { ...x, field_id: newFieldId() } : x));
    const farmId = s.farms.some((f) => f.farm_id === farm.farm_id) ? newFarmId() : farm.farm_id;
    const next = { ...farm, farm_id: farmId, fields };
    return { ...s, farms: [...s.farms, next], selected_farm_id: farmId, selected_field_id: null };
  },
  renameFarm(s: FarmStore, farmId: string, name: string): FarmStore {
    return mapFarm(s, farmId, (f) => ({ ...f, name: name.trim() || f.name }));
  },
  deleteFarm(s: FarmStore, farmId: string): FarmStore {
    const farms = s.farms.filter((f) => f.farm_id !== farmId);
    const sel = s.selected_farm_id === farmId ? (farms[0]?.farm_id ?? null) : s.selected_farm_id;
    return { ...s, farms, selected_farm_id: sel, selected_field_id: s.selected_farm_id === farmId ? null : s.selected_field_id };
  },
  selectFarm(s: FarmStore, farmId: string | null): FarmStore {
    if (farmId !== null && !s.farms.some((f) => f.farm_id === farmId)) return s;
    return { ...s, selected_farm_id: farmId, selected_field_id: null };
  },
  /** Throws if the geometry is invalid: callers check first and show the message. */
  addField(s: FarmStore, farmId: string, geometry: FieldGeometry, name?: string, approx = false): { store: FarmStore; field: Field } {
    const problem = checkGeometry(geometry);
    if (problem) throw new Error(problem.message);
    const farm = s.farms.find((f) => f.farm_id === farmId);
    if (!farm) throw new Error("No such farm.");
    const field: Field = { field_id: newFieldId(), name: name?.trim() || nextFieldName(farm), geometry, display_area_ha: areaHa(geometry), plan: null, ...(approx ? { approx_shape: true } : {}) };
    return { field, store: { ...mapFarm(s, farmId, (f) => ({ ...f, fields: [...f.fields, field] })), selected_farm_id: farmId, selected_field_id: field.field_id } };
  },
  updateField(s: FarmStore, fieldId: string, patch: Partial<Pick<Field, "name" | "geometry" | "plan" | "notes" | "equipment" | "readings">>): FarmStore {
    const farm = farmOfField(s, fieldId);
    if (!farm) return s;
    if (patch.geometry) {
      const problem = checkGeometry(patch.geometry);
      if (problem) throw new Error(problem.message);
    }
    return mapFarm(s, farm.farm_id, (f) => ({
      ...f,
      fields: f.fields.map((x) => {
        if (x.field_id !== fieldId) return x;
        const next: Field = { ...x, ...patch };
        if (patch.name !== undefined) next.name = patch.name.trim() || x.name;
        if (patch.geometry) {
          next.display_area_ha = areaHa(patch.geometry);
          // A shape the grower has traced or corrected is no longer the stand-in square.
          delete next.approx_shape;
        }
        return next;
      }),
    }));
  },
  deleteField(s: FarmStore, fieldId: string): FarmStore {
    const farm = farmOfField(s, fieldId);
    if (!farm) return s;
    const next = mapFarm(s, farm.farm_id, (f) => ({ ...f, fields: f.fields.filter((x) => x.field_id !== fieldId) }));
    return s.selected_field_id === fieldId ? { ...next, selected_field_id: null } : next;
  },
  selectField(s: FarmStore, fieldId: string | null): FarmStore {
    if (fieldId === null) return { ...s, selected_field_id: null };
    const farm = farmOfField(s, fieldId);
    if (!farm) return s;
    return { ...s, selected_farm_id: farm.farm_id, selected_field_id: fieldId };
  },
};

export function nextFieldName(farm: Farm): string {
  const used = new Set(farm.fields.map((f) => f.name));
  for (let i = farm.fields.length + 1; ; i++) if (!used.has(`Field ${i}`)) return `Field ${i}`;
}
