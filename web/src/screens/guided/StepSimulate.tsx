import { ConfidenceBadge } from "../../ui/ConfidenceBadge";
import type { LossAssumptions, Simulation } from "../../api/simModel";
import { updateSimField } from "../../state/simField";
import { useSimulation, type SimState } from "../../state/useSimulation";
import { Banner } from "../../ui/components";
import { G } from "../../ui/Glossary";
import { simulateRequest, type StepContext } from "./context";
import { MethodNote, ReadingsBeside, ScenarioSummary, YearTable } from "./SimViews";
import { ScenarioResults, simulationResultSchema } from "../../sim";

/*
  Step 3: the current plan alone, through the next 10 years of this field's real past seasons in new orders (§11 with only the
  baseline). The farmer's optional loss estimate is the only bridge from weather to money.
*/
export function SimStatus({ sim, onRetry, what }: { sim: SimState; onRetry: () => void; what: string }) {
  if (sim.state === "loading" || sim.state === "idle")
    return (
      <p className="gf-running" role="status">
        {sim.state === "loading" && sim.note ? sim.note : `Running ${what} through the coming years… This can take up to a minute on the first run.`}
      </p>
    );
  if (sim.state === "error")
    return (
      <Banner kind="error">
        <strong>{sim.message}</strong>
        {sim.detail ? <span className="error-detail"> {sim.detail}</span> : null}{" "}
        <button type="button" className="btn btn-quiet" onClick={onRetry}>
          Try again
        </button>
      </Banner>
    );
  return null;
}

function LossEditor({ ctx }: { ctx: StepContext }) {
  const { sim, field } = ctx;
  const rows: Array<{ k: keyof LossAssumptions; label: string }> = [
    { k: "drySpringPct", label: "In a dry spring I lose about" },
    { k: "heavyRainPct", label: "In a heavy-rain year I lose about" },
  ];
  return (
    <section className="db-card gf-loss" aria-label="Your loss estimate">
      <div className="db-card-head">
        <h2>
          Your loss estimate <span className="gf-muted">(optional)</span>
        </h2>
      </div>
      <p className="gf-muted">
        Leave these blank and money and weather risk are shown side by side, never combined. Fill one in and margins use your <G id="loss-assumption">estimate</G>, labelled as yours.
      </p>
      <div className="gf-loss-grid">
        {rows.map((r) => (
          <label key={r.k} className="gf-loss-row">
            <span>{r.label}</span>
            <input
              className="gf-num"
              inputMode="numeric"
              placeholder="Not set"
              defaultValue={sim.loss[r.k] ?? ""}
              aria-label={`${r.label} (percent of yield)`}
              onBlur={(e) => {
                const t = e.target.value.trim();
                const n = Number(t);
                updateSimField(field!.field_id, (cur) => ({ loss: { ...cur.loss, [r.k]: t === "" || !Number.isFinite(n) ? null : Math.max(0, Math.min(100, n)) } }));
              }}
            />
            <span>% of yield</span>
          </label>
        ))}
      </div>
    </section>
  );
}

export function SimulationResult({ data }: { data: Simulation }) {
  // U2's view reads the response in the backend's shape; a response its stricter schema
  // rejects falls back to D's view of the adapted model, so the step never goes blank.
  const parsed = simulationResultSchema.safeParse(data.raw);
  const u2 = parsed.success ? parsed.data.scenarios[0] : undefined;
  const s = data.scenarios[0];
  if (!s) return <p className="gf-muted">The service returned no result for this plan.</p>;
  return (
    <>
      <section className="db-card" aria-label="10-year result">
        <div className="db-card-head">
          <h2>{s.label}: 10 years</h2>
          <ConfidenceBadge value={(data.raw.method as Record<string, unknown> | undefined)?.confidence} label="Simulation support" />
        </div>
        <MethodNote sim={data} />
        {u2 ? <ScenarioResults scenario={u2} /> : <ScenarioSummary s={s} />}
        <p className="gf-muted">
          Each value is the middle of all the simulated years, with its <G id="band">typical range</G>. <G id="margin">Margin</G> uses your numbers where you gave them.
        </p>
      </section>
      {u2 ? null : (
        <section className="db-card" aria-label="Year by year">
          <div className="db-card-head">
            <h2>Year by year</h2>
          </div>
          <YearTable s={s} />
          <ReadingsBeside s={s} />
        </section>
      )}
    </>
  );
}

export function StepSimulate({ ctx }: { ctx: StepContext }) {
  const req = simulateRequest(ctx, []);
  const { sim, run } = useSimulation(ctx.api.client, req, ctx.active !== false);
  return (
    <div className="gf-sim">
      <LossEditor ctx={ctx} />
      <div className="gf-run">
        <label className="gf-inline">
          First season
          <input
            className="gf-num"
            inputMode="numeric"
            defaultValue={ctx.sim.startSeason}
            aria-label="First season of the 10 years"
            onBlur={(e) => /^\d{4}$/.test(e.target.value) && updateSimField(ctx.field!.field_id, { startSeason: e.target.value })}
          />
        </label>
        <button type="button" className="btn btn-secondary" onClick={run} disabled={!req || sim.state === "loading"}>
          Run again
        </button>
      </div>
      <SimStatus sim={sim} onRetry={run} what="your current plan" />
      {sim.state === "ready" ? <SimulationResult data={sim.data} /> : null}
    </div>
  );
}
