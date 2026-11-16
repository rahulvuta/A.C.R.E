import { lazy, Suspense } from "react";
import type { GlobalClient } from "../../api/client";
import type { LatLon, RegionProfile } from "../../api/model";
import type { Field } from "../../farm/types";

/*
  The planning screens (P4–P6, `src/planning/`) for the selected field, loaded lazily so the
  map page does not carry them. See FieldPlanning.tsx.
*/
export type PlanningStep = "goals" | "find" | "future";
export interface PlanningProps {
  client: GlobalClient;
  field: Field;
  point: LatLon;
  profile: RegionProfile | null;
  onStep: (s: PlanningStep | "plan") => void;
}

const FieldPlanning = lazy(() => import("./FieldPlanning"));

export function PlanningSlot(props: PlanningProps & { step: PlanningStep }) {
  return (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <FieldPlanning key={props.field.field_id} {...props} />
    </Suspense>
  );
}
