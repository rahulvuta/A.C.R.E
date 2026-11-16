import { useSyncExternalStore } from "react";
import type { FieldPlan } from "../farm/types";

/*
  Unsaved plan drafts, one per field (card D2). Switching fields keeps each draft; "Save plan"
  writes it to the field in the farm store. Kept in memory only (the saved plan persists).
*/
let drafts: Record<string, FieldPlan> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setDraft(fieldId: string, plan: FieldPlan) {
  drafts = { ...drafts, [fieldId]: plan };
  emit();
}
export function clearDraft(fieldId: string) {
  const { [fieldId]: _gone, ...rest } = drafts;
  void _gone;
  drafts = rest;
  emit();
}
export function getDraft(fieldId: string): FieldPlan | null {
  return drafts[fieldId] ?? null;
}
export function useDraft(fieldId: string | null): FieldPlan | null {
  return useSyncExternalStore(subscribe, () => (fieldId ? (drafts[fieldId] ?? null) : null));
}
export function resetDraftsForTests() {
  drafts = {};
  emit();
}
