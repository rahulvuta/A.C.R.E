import { useEffect, useState } from "react";
import { asFieldPlan } from "../../api/adapt";
import { PRIORITY_NAMES, type Recommendation } from "../../api/model";
import type { Scenario } from "../../api/simModel";
import { areaHa } from "../../farm/geometry";
import { MAX_ALTERNATIVES, updateSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { OriginBadge } from "../../ui/OriginBadge";
import { rotationReady, type StepContext } from "./context";
import { cropLabel } from "./format";
import { RotationEditor } from "./StepNow";

/*
  Step 4: alternatives. Suggestions come from POST /v1/plans/recommend (the generator's
  Pareto shortlist for this field and these goals), each turned into a scenario as-is;
  "Build your own" starts from a copy of the current plan. At most 5 alongside the baseline.
*/
/** The backend's sentence up to its list of the other plans' values (the full text is one click away). */
const firstSentence = (t: string) => t.split(/ \(others:|(?<=\.) /)[0] ?? t;
const newId = () => `s_${Math.random().toString(36).slice(2, 8)}`;

function PrioritiesEditor({ ctx }: { ctx: StepContext }) {
  const { sim, field } = ctx;
  const [labels, setLabels] = useState<Record<string, { label: string; explanation: string | null }>>({});
  useEffect(() => {
    let live = true;
    void ctx.api.client.vocab("priorities").then((r) => {
      if (live && r.ok) setLabels(Object.fromEntries(r.data.map((v) => [v.id, { label: v.label, explanation: v.explanation }])));
    });
    return () => {
      live = false;
    };
  }, [ctx.api.client]);
  const names = Object.keys(sim.priorities);
  return (
    <section className="db-card" aria-label="Your priorities">
      <div className="db-card-head">
        <h2>Your priorities</h2>
      </div>
      <p className="gf-muted">How much each one matters to you, from 0 (not at all) to 3 (a lot). They shape the suggestions and the "best for your priorities" badge.</p>
      <div className="gf-prio">
        {names.map((n) => (
          <label key={n} className="gf-prio-row">
            <span>
              <strong>{labels[n]?.label ?? cropLabel(n)}</strong>
              {labels[n]?.explanation ? <span className="gf-muted gf-block">{labels[n]!.explanation}</span> : null}
            </span>
            <select value={sim.priorities[n]} aria-label={`${labels[n]?.label ?? n} weight`} onChange={(e) => updateSimField(field!.field_id, (cur) => ({ priorities: { ...cur.priorities, [n]: Number(e.target.value) } }))}>
              {[0, 1, 2, 3].map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

export function StepTry({ ctx }: { ctx: StepContext }) {
  const { field, sim, point } = ctx;
  const [rec, setRec] = useState<{ state: "idle" | "loading" } | { state: "ready"; data: Recommendation } | { state: "error"; message: string }>({ state: "idle" });
  const [editing, setEditing] = useState<string | null>(null);
  const full = sim.scenarios.length >= MAX_ALTERNATIVES;
  // /recommend knows the six soil and water priorities; profit is weighed in Compare.
  const goalPriorities = Object.fromEntries(PRIORITY_NAMES.map((n) => [n, sim.priorities[n] ?? 0]));
  const key = JSON.stringify([point, goalPriorities, sim.equipment]);
  useEffect(() => {
    if (!point || !field) return;
    let live = true;
    setRec({ state: "loading" });
    const ha = areaHa(field.geometry);
    void ctx.api.client
      .recommend({ point }, { priorities: goalPriorities }, { fieldId: field.field_id, areaHa: ha > 0 ? Math.round(ha * 100) / 100 : null, cropHistory: [], equipment: sim.equipment })
      .then((r) => live && setRec(r.ok ? { state: "ready", data: r.data } : { state: "error", message: r.message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!field) return null;
  const save = (scenarios: Scenario[]) => updateSimField(field.field_id, { scenarios });
  const add = (s: Scenario) => !full && save([...sim.scenarios, s]);
  const suggestions = rec.state === "ready" ? rec.data.shortlist : [];
  const added = new Set(sim.scenarios.map((s) => s.label));

  return (
    <div className="gf-try">
      <PrioritiesEditor ctx={ctx} />
      <section className="db-card" aria-label="Your plans to compare">
        <div className="db-card-head">
          <h2>
            Plans to compare <span className="gf-muted">({sim.scenarios.length} of {MAX_ALTERNATIVES})</span>
          </h2>
          <button
            type="button"
            className="btn btn-primary"
            disabled={full || !rotationReady(sim.rotation)}
            onClick={() => {
              const id = newId();
              add({ scenarioId: id, label: `My plan ${sim.scenarios.filter((s) => s.from === "custom").length + 1}`, isBaseline: false, rotation: sim.rotation.map((p, i) => ({ ...p, plan_id: `${id}_s${i + 1}` })), from: "custom" });
              setEditing(id);
            }}
          >
            Build your own
          </button>
        </div>
        {sim.scenarios.length ? (
          <ul className="gf-scen-list">
            {sim.scenarios.map((s) => (
              <li key={s.scenarioId}>
                <div className="gf-scen-row">
                  <span>
                    <strong>{s.label}</strong> <span className="gf-muted">{s.from === "suggested" ? "Suggested" : "Built by you"}</span>
                    <span className="gf-block gf-muted">{s.rotation.map((p) => [p.previous_crop_id, p.winter.kind !== "none" ? p.winter.crop_id : null, p.next_crop_id].filter(Boolean).map((c) => cropLabel(c!)).join(" → ")).join(" · ")}</span>
                  </span>
                  <span className="gf-season-actions">
                    {s.from === "custom" ? (
                      <button type="button" className="btn btn-quiet" onClick={() => setEditing(editing === s.scenarioId ? null : s.scenarioId)}>
                        {editing === s.scenarioId ? "Done editing" : "Edit"}
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-quiet" onClick={() => save(sim.scenarios.filter((x) => x.scenarioId !== s.scenarioId))}>
                      Remove
                    </button>
                  </span>
                </div>
                {editing === s.scenarioId ? (
                  <div className="gf-edit">
                    <label className="gf-inline">
                      Name
                      <input defaultValue={s.label} aria-label="Plan name" onBlur={(e) => save(sim.scenarios.map((x) => (x.scenarioId === s.scenarioId ? { ...x, label: e.target.value.trim() || x.label } : x)))} />
                    </label>
                    <RotationEditor ctx={ctx} idPrefix={s.scenarioId} rotation={s.rotation} onChange={(r) => save(sim.scenarios.map((x) => (x.scenarioId === s.scenarioId ? { ...x, rotation: r } : x)))} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="gf-muted">No plans yet. Add a suggestion below or build your own.</p>
        )}
      </section>
      <section className="db-card" aria-label="Suggested plans">
        <div className="db-card-head">
          <h2>Suggested for this field</h2>
        </div>
        {rec.state === "loading" ? (
          <p className="gf-muted" role="status">
            Finding plans that fit this place and your priorities…
          </p>
        ) : null}
        {rec.state === "error" ? <Banner kind="info">{rec.message} You can still build your own.</Banner> : null}
        {rec.state === "ready" && !suggestions.length ? <p className="gf-muted">{rec.data.reasonText ?? "No suggestions for these priorities. Try other weights, or build your own."}</p> : null}
        <ul className="gf-suggest">
          {suggestions.map((o) => {
            const rotation = o.plans.map(asFieldPlan).filter((p): p is NonNullable<typeof p> => Boolean(p));
            const has = added.has(o.label);
            return (
              <li key={o.candidateId}>
                <div>
                  <strong>{o.label}</strong>
                  {o.why[0] ? <span className="gf-block gf-muted">{firstSentence(o.why[0].text)}</span> : null}
                  {o.why.length || o.uncertainties.length ? (
                    <details className="gf-more">
                      <summary>Why, and what is uncertain</summary>
                      {o.why.map((w) => (
                        <p key={w.indicator}>{w.text}</p>
                      ))}
                      {o.uncertainties.map((u) => (
                        <p key={u.text}>
                          {u.text} <OriginBadge origin={u.origin} />
                        </p>
                      ))}
                    </details>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={has || full || !rotation.length}
                  onClick={() => add({ scenarioId: newId(), label: o.label, isBaseline: false, rotation, from: "suggested" })}
                >
                  {has ? "Added" : "Add to compare"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
