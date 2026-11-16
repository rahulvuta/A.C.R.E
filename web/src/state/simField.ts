import { parseSaved } from "./storageBackup";
import type { EconomicsValue, PlanEditorValue } from "../inputs";
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
/** One part of the field with its own crops. `share` is a fraction of the field (0 to 1). */
export interface SimZone {
  zoneId: string;
  name: string;
  share: number;
}
export interface SimField {
  /** The field's rotation; with zones, the largest zone's (so screens that show one plan keep working). */
  rotation: FieldPlan[];
  /** Zones of the field, empty when the whole field has one plan. */
  zones?: SimZone[];
  /** Each zone's own current rotation. */
  zoneRotations?: Record<string, FieldPlan[]>;
  equipment: string[];
  readings: Reading[];
  conditionAssessment?: { inputsKey: string; assessment: import("../inputs/conditions").ConditionAssessment };
  overrides: Record<string, CropOverride>;
  loss: LossAssumptions;
  priorities: Record<string, number>;
  economicsInputs?: EconomicsValue;
  planInputs?: Record<string, Pick<PlanEditorValue, "dates" | "cropDetails">>;
  /** Alternatives to the current plan (at most 5). */
  scenarios: Scenario[];
  chosenId: string | null;
  startSeason: string;
  /** Set when the field came from a demo farm, so the screens say "example values". */
  demo: string | null;
  /** Ways this field is farmed that the plan cannot hold yet (card 21); the results say what they leave out. */
  fitNotes?: string[];
}
export const MAX_ALTERNATIVES = 5;
export const MAX_ZONES = 8;
/** Zones are switched off for now: the editor is hidden and a field is always simulated as one plan. */
export const ZONES_ENABLED = false;
/** The field's zones, or none while zones are switched off. */
export const zonesOf = (f: Pick<SimField, "zones">): SimZone[] => (ZONES_ENABLED ? (f.zones ?? []) : []);
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
  zones: [],
  zoneRotations: {},
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
    const parsed = raw ? (parseSaved(KEY, raw) as { fields?: Record<string, SimField> }) : null;
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

/** The baseline scenario: the field's current rotation (per zone when the field has zones). */
export function baselineOf(f: SimField): Scenario {
  const zoned = zonesOf(f).length > 0;
  return { scenarioId: BASELINE_ID, label: "What I do now", isBaseline: true, rotation: f.rotation, ...(zoned ? { zoneRotations: f.zoneRotations ?? {} } : {}), from: "current" };
}

/** Sets the zones and their rotations together; `rotation` follows the largest zone. Fewer than two zones means no zones. */
export function setZoneLayout(fieldId: string, zones: SimZone[], zoneRotations: Record<string, FieldPlan[]>) {
  if (zones.length < 2) {
    const only = zones[0] ? (zoneRotations[zones[0].zoneId] ?? []) : getSimField(fieldId).rotation;
    updateSimField(fieldId, { zones: [], zoneRotations: {}, rotation: only });
    return;
  }
  const biggest = zones.reduce((a, z) => (z.share > a.share ? z : a), zones[0]!);
  updateSimField(fieldId, { zones, zoneRotations, rotation: zoneRotations[biggest.zoneId] ?? [] });
}
export const newZoneId = () => `zn_${Math.random().toString(36).slice(2, 8)}`;
/** Equal shares that add up to exactly 1. */
export function evenShares(n: number): number[] {
  const each = Math.floor(10000 / n) / 10000;
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? Math.round((1 - each * (n - 1)) * 10000) / 10000 : each));
}

export function resetSimFieldsForTests() {
  state = {};
  listeners.forEach((l) => l());
}
