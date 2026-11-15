import { useSyncExternalStore } from "react";
import type { FieldPlan } from "../farm/types";
import type { CropOverride, DemoFarm, LossAssumptions, Reading, Scenario } from "../api/simModel";

/*
  Per-field simulator state (card U1): the field's current rotation ("what I do now"),
  equipment, the farmer's own readings, economics overrides, loss assumptions, priorities,
  the alternative scenarios and the one the farmer chose. Saved only in this browser
  (localStorage `acre.simfield.v1`, keyed by field_id), next to the farms in `acre.farms.v1`.
  It leaves the browser only inside a simulate / economics request (contract §14).
*/
export interface SimField {
  rotation: FieldPlan[];
  equipment: string[];
  readings: Reading[];
  overrides: Record<string, CropOverride>;
  loss: LossAssumptions;
  priorities: Record<string, number>;
  /** Alternatives to the current plan (at most 5). */
  scenarios: Scenario[];
  chosenId: string | null;
  startSeason: string;
  /** Set when the field came from a demo farm, so the screens say "example values". */
  demo: string | null;
}
export const MAX_ALTERNATIVES = 5;
export const BASELINE_ID = "current";
const KEY = "acre.simfield.v1";

export const DEFAULT_PRIORITIES: Record<string, number> = {
  soil_cover: 1,
  water_conservation: 1,
  weather_resilience: 1,
  crop_diversity: 1,
  living_cover_duration: 1,
  management_simplicity: 1,
  profit: 1,
};
export const emptySimField = (): SimField => ({
  rotation: [],
  equipment: [],
  readings: [],
  overrides: {},
  loss: { drySpringPct: null, wetSpringPct: null, heavyRainPct: null },
  priorities: { ...DEFAULT_PRIORITIES },
  scenarios: [],
  chosenId: null,
  startSeason: String(new Date().getFullYear() + 1),
  demo: null,
});

function load(): Record<string, SimField> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as { fields?: Record<string, SimField> }) : null;
    return parsed?.fields ?? {};
  } catch {
    return {};
  }
}
let state: Record<string, SimField> | null = null;
const get = () => (state ??= typeof window === "undefined" ? {} : load());
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ schema: KEY, fields: state }));
  } catch {
    // Storage blocked: the state lives for this page only.
  }
  listeners.forEach((l) => l());
}

export function getSimField(fieldId: string): SimField {
  return get()[fieldId] ?? emptySimField();
}
export const hasSimField = (fieldId: string) => fieldId in get();
export function updateSimField(fieldId: string, patch: Partial<SimField> | ((cur: SimField) => Partial<SimField>)) {
  const cur = getSimField(fieldId);
  const p = typeof patch === "function" ? patch(cur) : patch;
  state = { ...get(), [fieldId]: { ...cur, ...p } };
  persist();
}
export function removeSimField(fieldId: string) {
  const { [fieldId]: _gone, ...rest } = get();
  state = rest;
  persist();
}

/** Loads a demo farm's per-field context (the farm itself goes to C's farm store). */
export function loadDemoFields(demo: DemoFarm) {
  const next = { ...get() };
  for (const f of demo.farm.fields) {
    const d = demo.fields[f.field_id];
    next[f.field_id] = {
      ...emptySimField(),
      rotation: d?.rotation ?? (f.plan ? [f.plan] : []),
      equipment: d?.equipment ?? [],
      readings: d?.readings ?? [],
      overrides: demo.overrides,
      loss: demo.lossAssumptions,
      priorities: { ...DEFAULT_PRIORITIES, ...demo.priorities },
      demo: demo.label,
    };
  }
  state = next;
  persist();
}

const EMPTY = emptySimField();
export function useSimField(fieldId: string | null): SimField {
  return useSyncExternalStore(subscribe, () => (fieldId ? (get()[fieldId] ?? EMPTY) : EMPTY));
}

/** The baseline scenario: the field's current rotation. */
export function baselineOf(f: SimField): Scenario {
  return { scenarioId: BASELINE_ID, label: "What I do now", isBaseline: true, rotation: f.rotation, from: "current" };
}

export function resetSimFieldsForTests() {
  state = {};
  listeners.forEach((l) => l());
}
