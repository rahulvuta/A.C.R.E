import { lazy, Suspense, type ComponentType } from "react";
import type { GlobalClient } from "../../api/client";
import type { LatLon, RegionProfile } from "../../api/model";
import type { Field } from "../../farm/types";

/*
  The planning screens (cards P4–P6, `src/planning/`, built in parallel), loaded lazily so this
  file builds whether or not they are in the checkout yet. D4 wires the real exports.
*/
export type PlanningStep = "goals" | "find" | "future";
export interface PlanningProps {
  client: GlobalClient;
  field: Field;
  point: LatLon;
  profile: RegionProfile | null;
  onStep: (s: PlanningStep | "plan") => void;
}
type Mod = Partial<Record<"GoalsScreen" | "FindPlansScreen" | "FuturePlanScreen", ComponentType<PlanningProps>>>;

const found = import.meta.glob<Mod>("../../planning/index.ts");
const loader = Object.values(found)[0];
const NAME: Record<PlanningStep, keyof Mod> = { goals: "GoalsScreen", find: "FindPlansScreen", future: "FuturePlanScreen" };
const lazies = Object.fromEntries(
  (Object.keys(NAME) as PlanningStep[]).map((s) => [
    s,
    loader ? lazy(() => loader().then((m) => ({ default: m[NAME[s]] ?? (() => <Missing />) }))) : null,
  ]),
) as Record<PlanningStep, ComponentType<PlanningProps> | null>;

function Missing() {
  return (
    <p className="ws-nomap" role="status">
      This planning step is not part of this build yet.
    </p>
  );
}

export function PlanningSlot({ step, ...props }: PlanningProps & { step: PlanningStep }) {
  const C = lazies[step];
  if (!C) return <Missing />;
  return (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <C {...props} />
    </Suspense>
  );
}
