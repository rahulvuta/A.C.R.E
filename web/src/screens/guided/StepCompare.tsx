import { updateSimField } from "../../state/simField";
import { useSimulation } from "../../state/useSimulation";
import { simulateRequest, type StepContext } from "./context";
import { CompareColumns, MethodNote } from "./SimViews";
import { SimStatus } from "./StepSimulate";
import { ScenarioCompare, simulationResultSchema } from "../../sim";
import { TimelineCompare, withRotations, type ScenarioResult as TimelineResult } from "../../timeline";
import { BASELINE_ID } from "../../state/simField";

/* Step 5: every plan side by side over the same resampled past weather (§11 with all scenarios). */
export function StepCompare({ ctx }: { ctx: StepContext }) {
  const { sim, field } = ctx;
  const req = simulateRequest(ctx, sim.scenarios);
  const { sim: result, run } = useSimulation(ctx.api.client, sim.scenarios.length ? req : null, true);
  const choose = (id: string) => {
    updateSimField(field!.field_id, { chosenId: id });
    ctx.go("plan");
  };
  if (!sim.scenarios.length)
    return (
      <section className="db-card">
        <p className="gf-muted">Add at least one other plan in the step before to compare it with your current plan.</p>
        <button type="button" className="btn btn-secondary" onClick={() => ctx.go("try")}>
          Try other plans
        </button>
      </section>
    );
  return (
    <div className="gf-cmp">
      <SimStatus sim={result} onRetry={run} what={`${sim.scenarios.length + 1} plans`} />
      {result.state === "ready" ? (
        <section className="db-card" aria-label="Comparison">
          <MethodNote sim={result.data} />
          {(() => {
            const parsed = simulationResultSchema.safeParse(result.data.raw);
            return parsed.success ? <ScenarioCompare result={parsed.data} baselineId={BASELINE_ID} onChoose={choose} /> : <CompareColumns sim={result.data} chosenId={sim.chosenId} onChoose={choose} />;
          })()}
        </section>
      ) : null}
      {result.state === "ready" && req ? <details className="db-card"><summary>Compare crop calendars</summary><TimelineCompare
        scenarios={withRotations(result.data.raw as unknown as { scenarios: TimelineResult[] }, { scenarios: req.scenarios.map(s => ({ scenario_id: s.scenarioId, rotation: s.rotation, is_baseline: s.isBaseline })) })}
        note={result.data.method.note}
      /></details> : null}
    </div>
  );
}
