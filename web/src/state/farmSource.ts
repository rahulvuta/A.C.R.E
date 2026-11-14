import { useSyncExternalStore } from "react";
import type { Farm, Field, FieldPlan } from "../farm/types";

/*
  Where the screens get the farm and the selected field. C2 owns the real store (drawing,
  localStorage `acre.farms.v1`, import and export) and publishes `useFarms()`,
  `useSelectedField()` and `selectField(id)`. Until it lands, this in-memory stand-in has the
  same three names, plus `updateFieldPlan`, which the plan editor needs (asked of C in
  log-D). It keeps nothing after a reload and sends nothing anywhere.
*/

interface Snapshot {
  farms: Farm[];
  selectedFarmId: string | null;
  selectedFieldId: string | null;
}

let snap: Snapshot = { farms: [], selectedFarmId: null, selectedFieldId: null };
const listeners = new Set<() => void>();
const set = (next: Snapshot) => {
  snap = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const get = () => snap;

export function useFarms(): { farms: Farm[]; farm: Farm | null } {
  const s = useSyncExternalStore(subscribe, get, get);
  return { farms: s.farms, farm: s.farms.find((f) => f.farm_id === s.selectedFarmId) ?? null };
}

export function useSelectedField(): Field | null {
  const s = useSyncExternalStore(subscribe, get, get);
  const farm = s.farms.find((f) => f.farm_id === s.selectedFarmId);
  return farm?.fields.find((f) => f.field_id === s.selectedFieldId) ?? null;
}

export function selectField(id: string | null): void {
  if (snap.selectedFieldId !== id) set({ ...snap, selectedFieldId: id });
}

/** Adds or replaces a farm and selects it (and its first field when none is selected). */
export function putFarm(farm: Farm): void {
  const others = snap.farms.filter((f) => f.farm_id !== farm.farm_id);
  const keep = farm.fields.some((f) => f.field_id === snap.selectedFieldId);
  set({ farms: [...others, farm], selectedFarmId: farm.farm_id, selectedFieldId: keep ? snap.selectedFieldId : (farm.fields[0]?.field_id ?? null) });
}

/** Saves one field's plan draft into the selected farm. */
export function updateFieldPlan(fieldId: string, plan: FieldPlan | null): void {
  const farm = snap.farms.find((f) => f.farm_id === snap.selectedFarmId);
  if (!farm) return;
  const next: Farm = {
    ...farm,
    updated_at: new Date().toISOString(),
    fields: farm.fields.map((f) => (f.field_id === fieldId ? { ...f, plan } : f)),
  };
  putFarm(next);
}

/** Test helper: back to an empty store. */
export function resetFarmSource(): void {
  set({ farms: [], selectedFarmId: null, selectedFieldId: null });
}
