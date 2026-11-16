import { parseSaved } from "./storageBackup";
import { useSyncExternalStore } from "react";
import type { GoalsPanelValue } from "../planning/GoalsPanel";
import type { RecommendationCandidate } from "../planning/api";

/*
  Per-field planning state (P4–P6 hosted by D): the field's goals and crop history from
  GoalsPanel, and the shortlisted plan the grower chose. Saved only in this browser
  (localStorage `acre.fieldplanning.v1`, keyed by field_id), next to the farms in
  `acre.farms.v1`. Nothing here is sent anywhere except as part of a planning request.
*/
export interface FieldPlanning {
  value: GoalsPanelValue;
  chosen: RecommendationCandidate | null;
}
const KEY = "acre.fieldplanning.v1";

function load(): Record<string, FieldPlanning> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (parseSaved(KEY, raw) as { fields?: Record<string, FieldPlanning> }) : null;
    return parsed?.fields ?? {};
  } catch {
    return {};
  }
}
let state: Record<string, FieldPlanning> | null = null;
const get = () => (state ??= typeof window === "undefined" ? {} : load());
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function saveFieldPlanning(fieldId: string, patch: Partial<FieldPlanning>, fallback: () => GoalsPanelValue) {
  const cur = get()[fieldId] ?? { value: fallback(), chosen: null };
  state = { ...get(), [fieldId]: { ...cur, ...patch } };
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ schema: KEY, fields: state }));
  } catch {
    // Storage blocked: the state lives for this page only.
  }
  listeners.forEach((l) => l());
}

export function useFieldPlanning(fieldId: string): FieldPlanning | null {
  return useSyncExternalStore(subscribe, () => get()[fieldId] ?? null);
}

export function resetFieldPlanningForTests() {
  state = {};
  listeners.forEach((l) => l());
}
