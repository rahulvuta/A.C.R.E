import { useSyncExternalStore } from "react";
import { createFarmStore, ops, type FarmStoreHandle, type Persistence } from "./store";
import type { Farm, FarmStore, Field, FieldGeometry, FieldPlan } from "./types";

/*
  Public API for the app (Agent D): `useFarms()`, `useSelectedField()`, `selectField(id)`.
  One store per page, backed by localStorage `acre.farms.v1` (memory if storage is blocked).
*/
function browserStorage() {
  try {
    const s = window.localStorage;
    const probe = "acre.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

let handle: FarmStoreHandle | null = null;
function store(): FarmStoreHandle {
  if (!handle) handle = createFarmStore(typeof window === "undefined" ? null : browserStorage());
  return handle;
}

/** Tests only: start over with a given storage (or the browser's). */
export function resetFarmStoreForTests(h?: FarmStoreHandle) {
  handle = h ?? null;
}

const update = (fn: (s: FarmStore) => FarmStore) => store().set(fn(store().get()));

/** Select a field anywhere in the saved farms (also selects its farm). `null` clears. */
export function selectField(fieldId: string | null): void {
  update((s) => ops.selectField(s, fieldId));
}

export const farmActions = {
  createFarm(name: string, anchor: { latitude: number; longitude: number }): Farm {
    const r = ops.createFarm(store().get(), name, anchor);
    store().set(r.store);
    return r.farm;
  },
  /** Add an imported farm as a new farm (never merged into an existing one). */
  addFarm(farm: Farm) {
    update((s) => ops.addFarm(s, farm));
  },
  renameFarm: (farmId: string, name: string) => update((s) => ops.renameFarm(s, farmId, name)),
  deleteFarm: (farmId: string) => update((s) => ops.deleteFarm(s, farmId)),
  selectFarm: (farmId: string | null) => update((s) => ops.selectFarm(s, farmId)),
  /** Throws with a plain message when the shape is invalid. */
  addField(farmId: string, geometry: FieldGeometry, name?: string, approx = false): Field {
    const r = ops.addField(store().get(), farmId, geometry, name, approx);
    store().set(r.store);
    return r.field;
  },
  /** Throws with a plain message when a new geometry is invalid. */
  updateField: (fieldId: string, patch: Partial<Pick<Field, "name" | "geometry" | "plan" | "notes" | "equipment" | "readings">>) => update((s) => ops.updateField(s, fieldId, patch)),
  setFieldPlan: (fieldId: string, plan: FieldPlan | null) => update((s) => ops.updateField(s, fieldId, { plan })),
  deleteField: (fieldId: string) => update((s) => ops.deleteField(s, fieldId)),
  selectField,
};

export interface FarmsView {
  store: FarmStore;
  farms: Farm[];
  /** The selected farm (same as `selectedFarm`). */
  farm: Farm | null;
  selectedFarm: Farm | null;
  selectedFieldId: string | null;
  persistence: Persistence;
  notice: string | null;
  actions: typeof farmActions;
}

const subscribe = (fn: () => void) => store().subscribe(fn);
const snapshot = () => store().get();

export function useFarms(): FarmsView {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const h = store();
  const selected = s.farms.find((f) => f.farm_id === s.selected_farm_id) ?? null;
  return {
    store: s,
    farms: s.farms,
    farm: selected,
    selectedFarm: selected,
    selectedFieldId: s.selected_field_id,
    persistence: h.persistence(),
    notice: h.notice(),
    actions: farmActions,
  };
}

/** The selected field, or null. */
export function useSelectedField(): Field | null {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const farm = s.farms.find((f) => f.farm_id === s.selected_farm_id);
  return farm?.fields.find((x) => x.field_id === s.selected_field_id) ?? null;
}

/** Saves one field's plan (D's plan editor). */
export function updateFieldPlan(fieldId: string, plan: FieldPlan | null): void {
  farmActions.setFieldPlan(fieldId, plan);
}

/** Adds a farm, or replaces the saved farm with the same id, and selects it. */
export function putFarm(farm: Farm): void {
  const s = store().get();
  if (s.farms.some((f) => f.farm_id === farm.farm_id)) {
    const keep = farm.fields.some((f) => f.field_id === s.selected_field_id);
    store().set({ ...s, farms: s.farms.map((f) => (f.farm_id === farm.farm_id ? farm : f)), selected_farm_id: farm.farm_id, selected_field_id: keep ? s.selected_field_id : (farm.fields[0]?.field_id ?? null) });
  } else store().set(ops.addFarm(s, farm));
}
