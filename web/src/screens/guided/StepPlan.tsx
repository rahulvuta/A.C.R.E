import { useState } from "react";
import { READING_KINDS, type Reading, type ReadingKind, type ScenarioResult } from "../../api/simModel";
import { FuturePlan, planSchema, type Plan } from "../../planning";
import { baselineOf, BASELINE_ID, updateSimField } from "../../state/simField";
import { useSimulation } from "../../state/useSimulation";
import { OriginBadge } from "../../ui/OriginBadge";
import { simulateRequest, type StepContext } from "./context";
import { cropLabel, NA } from "./format";
import { SimStatus } from "./StepSimulate";
import { pick, useInputsModule } from "./slots";
import { TenYearTimeline, withRotations, type ScenarioResult as TimelineResult } from "../../timeline";

/*
  Step 6: the chosen plan as a 10-year timeline (U4's TenYearTimeline when merged), then
  the future-plan actions for its seasons (§10, P's FuturePlan: windows, deadlines, backup),
  the readings log, print and export.
*/
const KIND_LABEL: Record<ReadingKind, string> = {
  soil_moisture_pct: "Soil moisture (%)",
  soil_moisture_vwc: "Soil moisture (VWC)",
  rainfall_mm: "Rain gauge (mm)",
  soil_temp_c: "Soil temperature (°C)",
  note: "Note",
};

export function ReadingsLog({ ctx }: { ctx: StepContext }) {
  const { field, sim } = ctx;
  const inputs = useInputsModule();
  const U3 = pick(inputs, "ReadingsLog");
  const [kind, setKind] = useState<ReadingKind>("soil_moisture_pct");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [value, setValue] = useState("");
  const [depth, setDepth] = useState("");
  const [note, setNote] = useState("");
  if (!field) return null;
  const save = (readings: Reading[]) => updateSimField(field.field_id, { readings });
  if (U3) return <U3 fieldId={field.field_id} readings={sim.readings} onChange={save} client={ctx.api.client} />;
  const sorted = [...sim.readings].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <section className="db-card" aria-label="Your readings">
      <div className="db-card-head">
        <h2>Your readings</h2>
      </div>
      <p className="gf-muted">Log what you measure on this field. Readings are shown beside NASA's modeled values and never mixed into them.</p>
      <form
        className="gf-reading-form"
        onSubmit={(e) => {
          e.preventDefault();
          const n = value.trim() === "" ? null : Number(value);
          if (kind !== "note" && (n == null || !Number.isFinite(n))) return;
          const d = depth.trim() === "" ? null : Number(depth);
          save([...sim.readings, { date, kind, value: kind === "note" ? null : n, depthCm: d != null && Number.isFinite(d) ? d : null, note: note.trim() || null }]);
          setValue("");
          setNote("");
        }}
      >
        <input type="date" aria-label="Reading date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <select aria-label="What you measured" value={kind} onChange={(e) => setKind(e.target.value as ReadingKind)}>
          {READING_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {kind !== "note" ? <input className="gf-num" aria-label="Value" inputMode="decimal" placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} required /> : null}
        {kind.startsWith("soil") ? <input className="gf-num" aria-label="Depth (cm)" inputMode="numeric" placeholder="Depth cm" value={depth} onChange={(e) => setDepth(e.target.value)} /> : null}
        <input aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} required={kind === "note"} />
        <button type="submit" className="btn btn-primary">
          Log reading
        </button>
      </form>
      {sorted.length ? (
        <table className="gf-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Reading</th>
              <th scope="col">Value</th>
              <th scope="col">Note</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.date}-${r.kind}-${i}`}>
                <td>{r.date}</td>
                <td>
                  {KIND_LABEL[r.kind]} <OriginBadge origin="grower" />
                </td>
                <td>{r.kind === "note" ? "" : `${r.value ?? NA}${r.depthCm != null ? ` at ${r.depthCm} cm` : ""}`}</td>
                <td>{r.note ?? ""}</td>
                <td>
                  <button type="button" className="btn btn-quiet" onClick={() => save(sim.readings.filter((x) => x !== r))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="gf-muted">No readings yet.</p>
      )}
    </section>
  );
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
  const { sim: result, run } = useSimulation(ctx.api.client, req, true);
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
