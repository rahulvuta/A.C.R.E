import { useMemo } from "react";
import { areaHa } from "../../farm/geometry";
import type { FieldPlan } from "../../farm/types";
import { createGoalsPanelValue, FuturePlan, generatePlans, GoalsPanel, planSchema, Recommendations, type RecommendationCandidate } from "../../planning";
import { usePlanningRequest, RequestError } from "../../planning/shared";
import { setDraft } from "../../state/drafts";
import { saveFieldPlanning, useFieldPlanning } from "../../state/fieldPlanning";
import type { PlanningProps, PlanningStep } from "./PlanningSlot";

/*
  The per-field planning flow (P4–P6 screens from src/planning, hosted by D):
  Goals → Find plans → Future plan. Goals and crop history are saved with the field
  (state/fieldPlanning.ts); "Edit this plan" opens the first season in the field plan editor.
*/
export default function FieldPlanning({ step, field, point, onStep }: PlanningProps & { step: PlanningStep }) {
  const saved = useFieldPlanning(field.field_id);
  const value = saved?.value ?? createGoalsPanelValue();
  const chosen = saved?.chosen ?? null;
  const location = useMemo(() => ({ latitude: point.latitude, longitude: point.longitude }), [point.latitude, point.longitude]);
  const ha = Math.round(areaHa(field.geometry) * 100) / 100;
  const context = { field_id: field.field_id, area_ha: ha > 0 ? ha : null, crop_history: value.crop_history.slice(-3), soil: null };
  const save = (patch: Parameters<typeof saveFieldPlanning>[1]) => saveFieldPlanning(field.field_id, patch, createGoalsPanelValue);

  const use = (c: RecommendationCandidate) => {
    save({ chosen: c });
    onStep("future");
  };
  const edit = (c: RecommendationCandidate) => {
    const p = c.plans[0];
    if (p) {
      const w = p.winter;
      const winter: FieldPlan["winter"] =
        w.kind === "cover" ? { kind: "cover", crop_id: w.crop_id ?? "", seed: w.seed ?? "", terminate: w.terminate ?? "" } : w.kind === "winter_grain" ? { kind: "winter_grain", crop_id: w.crop_id ?? "", plant: w.plant ?? "", harvest: w.harvest ?? "" } : { kind: "none" };
      setDraft(field.field_id, {
        plan_id: `${field.field_id}_plan`,
        label: c.label ?? undefined,
        previous_crop_id: p.previous_crop_id,
        next_crop_id: p.next_crop_id,
        prev_harvest: p.prev_harvest,
        next_plant: p.next_plant,
        winter,
        grower: { low_moisture_concern: field.plan?.grower?.low_moisture_concern ?? null },
        origins: { crops: "assumed", dates: "assumed", winter: "assumed" },
      });
    }
    onStep("plan");
  };

  if (step === "goals")
    return (
      <form
        className="db-card ws-planning"
        aria-label={`Goals for ${field.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          onStep("find");
        }}
      >
        <GoalsPanel value={value} onChange={(v) => save({ value: v })} />
        <div className="ws-next">
          <button type="submit" className="btn btn-primary">
            Find plans for {field.name}
          </button>
        </div>
      </form>
    );

  if (step === "find")
    return (
      <div className="ws-planning">
        <Recommendations location={location} field={context} goals={value.goals} onUsePlan={use} onEditPlan={edit} onPlanManually={() => onStep("plan")} />
      </div>
    );

  // Future plan: the chosen shortlist plan (with its date origins recovered from /generate),
  // else the field's own saved plan, which the backend treats as grower input.
  const own = field.plan ? planSchema.safeParse(field.plan) : null;
  return (
    <div className="ws-planning">
      {chosen ? (
        <ChosenFuture location={location} field={context} goals={value.goals} chosen={chosen} onBack={() => onStep("find")} />
      ) : own?.success ? (
        <FuturePlan location={location} plan={own.data} seasons={value.goals.constraints.seasons} priorities={value.goals.priorities} />
      ) : (
        <p className="db-card fr-state">
          Choose a plan in Find plans, or save a plan for {field.name}, to lay it out over the coming seasons.
        </p>
      )}
    </div>
  );
}

function ChosenFuture({
  location,
  field,
  goals,
  chosen,
  onBack,
}: {
  location: { latitude: number; longitude: number };
  field: { field_id: string; area_ha: number | null; crop_history: string[]; soil: null };
  goals: ReturnType<typeof createGoalsPanelValue>["goals"];
  chosen: RecommendationCandidate;
  onBack: () => void;
}) {
  const request = { location, field, goals };
  const { data, error, loading, retry } = usePlanningRequest(JSON.stringify([request, chosen.candidate_id]), async (signal) => {
    const result = await generatePlans(request, signal);
    const c = result.candidates.find((x) => x.candidate_id === chosen.candidate_id);
    if (!c || JSON.stringify(c.seasons.map((s) => planSchema.parse(s.plan))) !== JSON.stringify(chosen.plans.map((p) => planSchema.parse(p))))
      throw new Error("The chosen plan could not be matched to the generated options. Go back to Find plans and choose it again.");
    return c;
  });
  if (loading) return <p className="db-card fr-state" role="status">Loading the chosen plan’s date sources…</p>;
  if (error)
    return (
      <>
        <RequestError message={error} onRetry={retry} />
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back to Find plans
        </button>
      </>
    );
  return data ? <FuturePlan location={location} candidate={data} seasons={goals.constraints.seasons} priorities={goals.priorities} /> : null;
}
