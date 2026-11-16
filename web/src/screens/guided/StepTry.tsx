import { useEffect, useState, type ReactNode } from "react";
import { asFieldPlan } from "../../api/adapt";
import { PRIORITY_NAMES, type Option, type Recommendation } from "../../api/model";
import type { Scenario } from "../../api/simModel";
import { areaHa } from "../../farm/geometry";
import type { FieldPlan } from "../../farm/types";
import { DEFAULT_PRIORITIES, MAX_ALTERNATIVES, updateSimField } from "../../state/simField";
import { Banner } from "../../ui/components";
import { OriginBadge } from "../../ui/OriginBadge";
import { rotationReady, type StepContext } from "./context";
import { cropLabel } from "./format";
import { plainFact, plainReasons } from "./reasons";
import { RotationEditor } from "./StepNow";

/*
  Step 4: alternatives. Suggestions come from POST /v1/plans/recommend (the generator's
  Pareto shortlist for this field and these goals), each turned into a scenario as-is;
  "Build your own" starts from a copy of the current plan. At most 5 alongside the baseline.
*/
const newId = () => `s_${Math.random().toString(36).slice(2, 8)}`;
/** How many suggestions are shown before "Show more". */
const FIRST = 3;
const MAX_PICKS = 3;

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const pic = (body: ReactNode) => (
  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" {...stroke}>
    {body}
  </svg>
);
/** What a grower may care about, in their words, with a picture each. The ids are the service's. */
const CHOICES: Array<{ id: string; label: string; icon: ReactNode }> = [
  { id: "profit", label: "Earn more money", icon: pic(<><circle cx="12" cy="12" r="8.500" /><path d="M14.500 9.500c-.500-1-1.400-1.500-2.500-1.500-1.500 0-2.500.800-2.500 2s1 1.700 2.500 2 2.500.800 2.500 2-1 2-2.500 2c-1.200 0-2.100-.500-2.600-1.500M12 6.500v11" /></>) },
  { id: "soil_cover", label: "Keep the soil covered", icon: pic(<><path d="M3 17h18M5 17c0-3 1.500-5 3.500-5S12 14 12 17M12 17c0-3 1.500-5 3.500-5S19 14 19 17" /><path d="M3 20.500h18" strokeOpacity="0.5" /></>) },
  { id: "water_conservation", label: "Keep water in the soil", icon: pic(<><path d="M12 3.500c3.200 3.800 5 6.500 5 9a5 5 0 0 1-10 0c0-2.500 1.800-5.200 5-9z" /><path d="M9.500 13a2.500 2.500 0 0 0 2.500 2.500" /></>) },
  { id: "weather_resilience", label: "Cope with dry and wet years", icon: pic(<><circle cx="8" cy="8" r="3" /><path d="M8 2.500v1M2.500 8h1M4.100 4.100l.700.700" /><path d="M10 18a3.500 3.500 0 0 1 .300-7 4.500 4.500 0 0 1 8.500 1.200A3 3 0 0 1 18.500 18z" /></>) },
  { id: "crop_diversity", label: "Grow different crops", icon: pic(<><path d="M6 21v-7M12 21V9M18 21v-5" /><path d="M6 14c-2 0-3-1.500-3-3.500 2 0 3 1.500 3 3.500zM12 9c0-2.500 1.500-4 4-4 0 2.500-1.500 4-4 4zM18 16c0-2 1-3.500 3-3.500 0 2-1 3.500-3 3.500z" /></>) },
  { id: "living_cover_duration", label: "Keep something growing longer", icon: pic(<><circle cx="12" cy="12" r="8.500" /><path d="M12 7v5l3 2" /></>) },
  { id: "management_simplicity", label: "Less field work", icon: pic(<><path d="M4 18l9-9M13 9l2.500-2.500a2.500 2.500 0 0 1 3.500 3.500L16.500 12.500z" /><path d="M4 18l-.500 2.500L6 20z" /></>) },
];

/**
 * "Pick up to three things that matter most." A picked one is sent with the highest weight and
 * the rest with none; with nothing picked every one counts the same.
 */
function PrioritiesEditor({ ctx }: { ctx: StepContext }) {
  const { sim, field } = ctx;
  const picked = CHOICES.filter((c) => (sim.priorities[c.id] ?? 0) >= 2).map((c) => c.id);
  const full = picked.length >= MAX_PICKS;
  const toggle = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : full ? picked : [...picked, id];
    updateSimField(field!.field_id, { priorities: next.length ? Object.fromEntries(CHOICES.map((c) => [c.id, next.includes(c.id) ? 3 : 0])) : { ...DEFAULT_PRIORITIES } });
  };
  return (
    <section className="db-card" aria-label="What matters most to you">
      <div className="db-card-head">
        <h2>
          Pick up to three things that matter most <span className="gf-muted">({picked.length} of {MAX_PICKS})</span>
        </h2>
      </div>
      <div className="gf-picks" role="group" aria-label="What matters most to you">
        {CHOICES.map((c) => {
          const on = picked.includes(c.id);
          return (
            <button key={c.id} type="button" className="gf-pick" aria-pressed={on} disabled={!on && full} onClick={() => toggle(c.id)}>
              <span className="gf-pick-icon">{c.icon}</span>
              <span>{c.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** One suggested plan: its crops, one plain reason with its number, and the rest one click away. */
function Suggestion({ option, all, has, full, onAdd }: { option: Option; all: Option[]; has: boolean; full: boolean; onAdd: (rotation: FieldPlan[]) => void }) {
  const rotation = option.plans.map(asFieldPlan).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const reasons = plainReasons(option, all);
  // Lead with what sets this plan apart; a measure it shares with other suggestions comes second.
  const lead = reasons.find((r) => !r.shared);
  const first = lead?.text ?? plainFact(option) ?? reasons[0]?.text ?? null;
  const rest = reasons.filter((r) => r !== lead && r.text !== first);
  return (
    <li>
      <div>
        <strong>{option.label}</strong>
        {first ? <span className="gf-block gf-reason">{first}</span> : null}
        {rest.length || option.uncertainties.length ? (
          <details className="gf-more">
            <summary>More about this plan</summary>
            {rest.map((r) => (
              <p key={r.indicator}>{r.text}</p>
            ))}
            {option.uncertainties.length ? <p className="gf-muted">What is not certain:</p> : null}
            {option.uncertainties.map((u) => (
              <p key={u.text}>
                {u.text} <OriginBadge origin={u.origin} />
              </p>
            ))}
          </details>
        ) : null}
      </div>
      <button type="button" className="btn btn-secondary" disabled={has || full || !rotation.length} onClick={() => onAdd(rotation)}>
        {has ? "Added" : "Add to compare"}
      </button>
    </li>
  );
}

export function StepTry({ ctx }: { ctx: StepContext }) {
  // A field under trees, tea or pasture: every suggestion below means taking it out.
  const lasting = ctx.sim.rotation.find((p) => p.permanent) ?? null;
  const { field, sim, point } = ctx;
  const [rec, setRec] = useState<{ state: "idle" | "loading" } | { state: "ready"; data: Recommendation } | { state: "error"; message: string }>({ state: "idle" });
  const [editing, setEditing] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const full = sim.scenarios.length >= MAX_ALTERNATIVES;
  // /recommend knows the six soil and water priorities; profit is weighed in Compare.
  // With none of the six picked (only "earn more money", say), they all count the same.
  const noneSet = PRIORITY_NAMES.every((n) => !sim.priorities[n]);
  const goalPriorities = Object.fromEntries(PRIORITY_NAMES.map((n) => [n, noneSet ? 1 : (sim.priorities[n] ?? 0)]));
  const key = JSON.stringify([point, goalPriorities, sim.equipment]);
  useEffect(() => {
    if (!point || !field || ctx.active === false) return;
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
  }, [key, attempt, ctx.active]);

  // The service's own word on whether checked local crop guidance exists for this place.
  const [catalogStatus, setCatalogStatus] = useState<string | null>(null);
  const pointKey = point ? `${point.latitude},${point.longitude}` : "";
  useEffect(() => {
    if (!point || ctx.active === false || typeof ctx.api.client.capabilities !== "function") return;
    let live = true;
    void ctx.api.client.capabilities(point).then((r) => live && setCatalogStatus(r.ok ? (r.data.features.find((c) => c.key === "catalog")?.status ?? null) : null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointKey, ctx.active]);

  if (!field) return null;
  const save = (scenarios: Scenario[]) => updateSimField(field.field_id, { scenarios });
  const add = (s: Scenario) => !full && save([...sim.scenarios, s]);
  const suggestions = rec.state === "ready" ? rec.data.shortlist : [];
  const added = new Set(sim.scenarios.map((s) => s.label));
  const visible = showAll ? suggestions : suggestions.slice(0, FIRST);
  const noLocalGuidance = catalogStatus != null && catalogStatus !== "complete";

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
                    <strong translate={s.from === "custom" ? "no" : undefined}>{s.label}</strong> <span className="gf-muted">{s.from === "suggested" ? "Suggested" : "Built by you"}</span>
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
        {lasting ? (
          <p className="gf-muted" role="note">
            Each of these would replace your {cropLabel(lasting.next_crop_id).toLowerCase()} with crops planted every year. Clearing a long-lived crop is a big step that the money here does not count.
          </p>
        ) : null}
        {rec.state === "loading" ? (
          <p className="gf-muted" role="status">
            Finding plans that fit this place and your priorities…
          </p>
        ) : null}
        {rec.state === "error" ? <Banner kind="info">{rec.message} You can still build your own. <button type="button" className="btn btn-quiet" onClick={() => setAttempt((n) => n + 1)}>Try suggestions again</button></Banner> : null}
        {rec.state === "ready" && !suggestions.length ? <p className="gf-muted">{rec.data.reasonText ?? "No suggestions for these choices. Pick other things that matter, or build your own."}</p> : null}
        {suggestions.length && noLocalGuidance ? (
          <Banner kind="info">
            <strong>No checked local guidance for this place yet.</strong> These suggestions are built from typical crop calendars for the area. Check them with someone who farms near you before you rely on one.
          </Banner>
        ) : null}
        <ul className="gf-suggest">
          {visible.map((o) => (
            <Suggestion key={o.candidateId} option={o} all={suggestions} has={added.has(o.label)} full={full} onAdd={(rotation) => add({ scenarioId: newId(), label: o.label, isBaseline: false, rotation, from: "suggested" })} />
          ))}
        </ul>
        {suggestions.length > FIRST ? (
          <button type="button" className="btn btn-quiet" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show the first three only" : `Show ${suggestions.length - FIRST} more`}
          </button>
        ) : null}
      </section>
    </div>
  );
}
