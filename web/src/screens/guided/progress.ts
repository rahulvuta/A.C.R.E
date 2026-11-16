import { baselineReady } from "./context";
import { economicsReady } from "./inputState";
import type { StepId } from "./steps";
import type { SimField } from "../../state/simField";

/** The step of the guided sequence a field should carry on from, read from what it has saved. */
export function nextStep(sim: SimField): StepId {
  if (!(baselineReady(sim) && economicsReady(sim))) return "now";
  if (sim.chosenId != null) return "plan";
  return sim.scenarios.length ? "compare" : "simulate";
}

/** The steps a field has already been through, for the progress line on its summary: every step before the one it carries on from. */
export function stepsDone(sim: SimField, hasField = true): Record<StepId, boolean> {
  const order: StepId[] = ["farm", "now", "simulate", "try", "compare", "plan"];
  const at = order.indexOf(nextStep(sim));
  const done = Object.fromEntries(order.map((id, i) => [id, i < at])) as Record<StepId, boolean>;
  return { ...done, farm: hasField, plan: sim.chosenId != null };
}
