import { type ScenarioResult } from "../../api/simModel";
import { FuturePlan, planSchema, type Plan } from "../../planning";
import { baselineOf, BASELINE_ID, updateSimField } from "../../state/simField";
import { useSimulation } from "../../state/useSimulation";
import { farmActions } from "../../farm/hooks";
import { ReadingsLog as U3ReadingsLog } from "../../inputs";
import { simulateRequest, type StepContext } from "./context";
import { cropLabel, NA } from "./format";
import { SimStatus } from "./StepSimulate";
import { TenYearTimeline, withRotations, type ScenarioResult as TimelineResult } from "../../timeline";

/*
  Step 6: the chosen plan as a 10-year timeline (U4's TenYearTimeline when merged), then
  the future-plan actions for its seasons (§10, P's FuturePlan: windows, deadlines, backup),
  the readings log, print and export.
*/
export function ReadingsLog({ ctx }: { ctx: StepContext }) {
  const { field, sim } = ctx;
  if (!field) return null;
  return <U3ReadingsLog value={sim.readings.map(r => ({ date: r.date, kind: r.kind, value: r.value, depth_cm: r.depthCm, note: r.note, origin: "grower" }))} onChange={readings => {
    const saved = readings.map(({ origin: _origin, depth_cm, ...r }) => ({ ...r, depthCm: depth_cm }));
    updateSimField(field.field_id, { readings: saved });
    farmActions.updateField(field.field_id, { readings: readings.map(({ origin: _origin, ...r }) => r) });
  }} />;
}

function TimelineTable({ s }: { s: ScenarioResult }) {
  return (
    <ol className="gf-timeline" aria-label={`${s.label}, year by year`}>
      {s.timeline.map((t) => (
        <li key={t.year}>
          <span className="gf-year">{t.season}</span>
          <span>{t.cropSequence.map(cropLabel).join(" → ") || NA}</span>
        </li>
      ))}
    </ol>
  );
}

export function StepPlan({ ctx }: { ctx: StepContext }) {
  const { sim, field, point } = ctx;
  const chosenId = sim.chosenId ?? BASELINE_ID;
  const scenario = chosenId === BASELINE_ID ? baselineOf(sim) : (sim.scenarios.find((s) => s.scenarioId === chosenId) ?? baselineOf(sim));
  const inCompare = sim.scenarios.some((s) => s.scenarioId === scenario.scenarioId);
  const req = simulateRequest(ctx, inCompare ? sim.scenarios : []);
  const { sim: result, run } = useSimulation(ctx.api.client, req, ctx.active !== false);
  const res = result.state === "ready" ? result.data.scenarios.find((s) => s.scenarioId === scenario.scenarioId) : undefined;
  // U4's timeline reads the §11 scenario in the backend's shape plus the rotation it was simulated from (for dates).
  const u4 =
    result.state === "ready" && req
      ? withRotations(result.data.raw as unknown as { scenarios: TimelineResult[] }, { scenarios: req.scenarios.map((x) => ({ scenario_id: x.scenarioId, rotation: x.rotation, is_baseline: x.isBaseline })) }).find((x) => x.scenario_id === scenario.scenarioId)
      : undefined;
  const plans = scenario.rotation.map((p) => planSchema.safeParse(p)).flatMap((r) => (r.success ? [r.data as Plan] : []));
  if (!field) return null;

  const exportPlan = () => {
    const body = { schema: "acre.plan-export.v1", field: { name: field.name }, scenario: { label: scenario.label, rotation: scenario.rotation }, timeline: res?.timeline ?? [], method: result.state === "ready" ? result.data.method : null, readings: sim.readings };
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${field.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-10-year-plan.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="gf-plan">
      <section className="db-card" aria-label="Your 10-year plan">
        <div className="db-card-head">
          <h2>
            {scenario.label} <span className="gf-muted">on {field.name}</span>
          </h2>
          <span className="gf-season-actions gf-no-print">
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className="btn btn-secondary" onClick={exportPlan}>
              Export
            </button>
          </span>
        </div>
        {sim.chosenId == null ? (
          <p className="gf-muted">
            You have not chosen a plan in Compare, so this shows your current plan.{" "}
            <button type="button" className="btn btn-quiet" onClick={() => ctx.go("compare")}>
              Compare plans
            </button>
          </p>
        ) : null}
        <SimStatus sim={result} onRetry={run} what="your chosen plan" />
        {u4 && result.state === "ready" ? <TenYearTimeline scenario={u4} note={result.data.method.note} compact /> : res ? <TimelineTable s={res} /> : null}
      </section>
      {point && plans.length && ctx.api.source !== "live" ? (
        <section className="db-card" aria-label="Actions and deadlines">
          <div className="db-card-head">
            <h2>Actions, deadlines and a backup</h2>
          </div>
          <p className="gf-muted">Dated actions, decision deadlines and a backup plan come from the A.C.R.E service, which this sample mode does not call.</p>
        </section>
      ) : null}
      {point && plans.length && ctx.api.source === "live" ? (
        <section className="db-card" aria-label="Actions and deadlines">
          <div className="db-card-head">
            <h2>Actions, deadlines and a backup</h2>
          </div>
          <FuturePlan key={JSON.stringify(plans)} location={point} plans={plans} startSeason={sim.startSeason} seasons={plans.length} />
        </section>
      ) : null}
      <ReadingsLog ctx={ctx} />
    </div>
  );
}
