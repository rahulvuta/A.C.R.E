import { useEffect, useMemo, useState, type ReactNode } from "react";
import { APP_NAME } from "../../config";
import { GLOSSARY } from "../../content/glossary";
import { putFarm, selectField, useFarms, useSelectedField } from "../../farm/hooks";
import { fieldPoint, useFieldPlace } from "../../state/useFieldPlace";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { hasSimField, loadDemoFields, updateSimField, useSimField } from "../../state/simField";
import { peekSimulation } from "../../state/useSimulation";
import { Banner, Term } from "../../ui/components";
import { navIcon } from "../planner/SideNav";
import { SourceBanner } from "../workspace/SourceBanner";
import { baselineReady, simulateRequest, type StepContext } from "./context";
import { STEPS, stepIndex, type StepDef, type StepId } from "./steps";
import { StepFarm } from "./StepFarm";
import { economicsReady } from "./inputState";
import { NOW_PARTS, StepNow, nowPartReady, type NowPart } from "./StepNow";
import { StepSimulate } from "./StepSimulate";
import { StepTry } from "./StepTry";
import { StepCompare } from "./StepCompare";
import { ReadingsLog, StepPlan } from "./StepPlan";

/*
  The Scenario Simulator's guided flow (card U1, docs/global/simulator.md): Your farm → What
  you do now → Simulate current plan → Try other plans → Compare → Your 10-year plan. The
  sidebar shows progress; each step asks one question. State is kept per field in the browser
  (state/simField.ts).
*/

function readStep(): StepId {
  const m = window.location.hash.match(/[#&]u=([a-z]+)/);
  const s = m?.[1] as StepId | undefined;
  return s && STEPS.some((x) => x.id === s) ? s : "farm";
}
function readPart(): NowPart {
  const m = window.location.hash.match(/[#&]p=([a-z]+)/);
  const p = m?.[1] as NowPart | undefined;
  return p && NOW_PARTS.some((x) => x.id === p) ? p : "crops";
}

export type DemoState = { state: "idle" } | { state: "loading"; which: string } | { state: "error"; message: string };

export function useDemoLoader(api: GlobalApi, after: () => void) {
  const [demo, setDemo] = useState<DemoState>({ state: "idle" });
  const load = async (which: "union" | "pergamino") => {
    setDemo({ state: "loading", which });
    const r = await api.client.demoFarm(which);
    if (!r.ok) {
      setDemo({ state: "error", message: r.message });
      return;
    }
    putFarm(r.data.farm);
    loadDemoFields(r.data);
    selectField(r.data.farm.fields[0]?.field_id ?? null);
    setDemo({ state: "idle" });
    after();
  };
  return { demo, load };
}

export function StepHeader({ step, children }: { step: StepDef; children?: ReactNode }) {
  const g = GLOSSARY[step.term];
  return (
    <header className="gf-head">
      <p className="gf-kicker">
        Step {step.n} of {STEPS.length}
      </p>
      <h2 className="gf-question">{step.question}</h2>
      <p className="gf-sentence">
        {step.sentence}{" "}
        <Term term="What does this mean?">
          <strong>{g.term}.</strong> {g.definition}
        </Term>
      </p>
      {children}
    </header>
  );
}

export function Guided({ api: given }: { api?: GlobalApi }) {
  const fallback = useGlobalApi();
  const api = given ?? fallback;
  const { farm } = useFarms();
  const field = useSelectedField();
  const sim = useSimField(field?.field_id ?? null);
  const [step, setStepState] = useState<StepId>(readStep);
  const [part, setPart] = useState<NowPart>(readPart);
  const go = (s: StepId, p: NowPart = "crops") => {
    setStepState(s);
    setPart(p);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#u=${s}${s === "now" ? `&p=${p}` : ""}`);
    window.scrollTo?.({ top: 0 });
  };
  const place = useFieldPlace(api.client, field);
  const profile = place?.profile.state === "ready" ? place.profile.data : null;
  const regionKey = profile?.regionKey ?? (place?.place.state === "ready" ? (place.place.data.regionKeys[0] ?? null) : null);
  // The simulation uses the field's own centre; the profile lookup above uses a rounded one.
  const point = useMemo(() => (field ? fieldPoint(field) : null), [field]);
  const ctx: StepContext = { api, farm, field, sim, point, regionKey, profile, go };

  useEffect(() => {
    const on = () => {
      setStepState(readStep());
      setPart(readPart());
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // A field this browser has not simulated yet starts from what the field itself carries
  // (its saved plan, and the equipment and readings C's demo loader or an import put on it).
  useEffect(() => {
    if (!field || hasSimField(field.field_id)) return;
    updateSimField(field.field_id, {
      rotation: field.plan ? [field.plan] : [],
      equipment: field.equipment ?? [],
      readings: (field.readings ?? []).map((r) => ({ date: r.date, kind: r.kind, value: r.value, depthCm: r.depth_cm ?? null, note: r.note ?? null })),
    });
  }, [field]);
  // A step past "Your farm" needs a field.
  useEffect(() => {
    if (!field && step !== "farm") setStepState("farm");
  }, [field, step]);

  const baseReq = simulateRequest(ctx, []);
  const fullReq = simulateRequest(ctx, sim.scenarios);
  const done: Record<StepId, boolean> = {
    farm: Boolean(farm?.fields.length),
    now: baselineReady(sim) && economicsReady(sim),
    simulate: peekSimulation(baseReq).state === "ready",
    try: sim.scenarios.length > 0,
    compare: sim.scenarios.length > 0 && peekSimulation(fullReq).state === "ready",
    plan: sim.chosenId != null,
  };
  const reachable = (s: StepId) => s === "farm" || (Boolean(field) && (s === "now" || done.now));
  const i = stepIndex(step);
  const def = STEPS[i]!;
  const next = STEPS[i + 1];
  const prev = STEPS[i - 1];
  const nextBlocked = next ? !reachable(next.id) : true;
  // Step 2 is asked one part at a time; Back and Next walk through its parts first.
  const pi = NOW_PARTS.findIndex((p) => p.id === part);
  const nextPart = step === "now" ? NOW_PARTS[pi + 1] : undefined;
  const prevPart = step === "now" ? NOW_PARTS[pi - 1] : undefined;
  const partReady = nowPartReady(part, sim);
  const partWhy: Record<NowPart, string> = {
    crops: "Pick the crops for every season first.",
    dates: "Fill in every planting and harvest date first.",
    equipment: "",
    prices: "Finish or reset the incomplete money entries first.",
    losses: "Complete your crops, dates and any money entries first.",
  };

  return (
    <div className="db ws gf">
      <aside className="db-side">
        <a className="db-brand" href="./" aria-label={`${APP_NAME} home`}>
          <span className="fb-mark" aria-hidden="true" />
          {APP_NAME}
        </a>
        <nav className="gf-steps" aria-label="Steps">
          <ol>
            {STEPS.map((s) => (
              <li key={s.id}>
                <button type="button" aria-current={step === s.id ? "step" : undefined} disabled={!reachable(s.id)} onClick={() => go(s.id, s.id === "now" && step === "now" ? part : "crops")} data-done={done[s.id] ? "yes" : "no"}>
                  <span className="gf-dot" aria-hidden="true">
                    {done[s.id] ? "✓" : s.n}
                  </span>
                  <span>{s.nav}</span>
                  <span className="sr-only">{done[s.id] ? " (done)" : ""}</span>
                </button>
                {s.id === "now" && step === "now" && field ? (
                  <ol className="gf-parts" aria-label="Parts of this step">
                    {NOW_PARTS.map((p, k) => (
                      <li key={p.id}>
                        <button type="button" aria-current={part === p.id ? "step" : undefined} disabled={k > 0 && !NOW_PARTS.slice(0, k).every((q) => nowPartReady(q.id, sim))} onClick={() => go("now", p.id)}>
                          {p.nav}
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ol>
        </nav>
        <div className="db-side-foot">
          <div className="db-links">
            <a href="?view=fields">{navIcon("M4 3h10v12H4zM7 7h4M7 10h4")}Field tools</a>
            <a href="?view=methods">{navIcon("M9 16A7 7 0 1 0 9 2a7 7 0 0 0 0 14zM7 7a2 2 0 1 1 3 1.700c-.600.400-1 .800-1 1.500M9 12.700v.100")}How it works</a>
            <a href="?view=privacy">{navIcon("M9 2l5.500 2v4.500c0 3.500-2.300 6-5.500 7.500-3.200-1.500-5.500-4-5.500-7.500V4zM6.700 9l1.700 1.700 3-3.200")}Privacy and terms</a>
          </div>
        </div>
      </aside>
      <div className="db-body">
        <header className="db-top">
          <div className="db-crumbs">
            <h1>{def.nav}</h1>
            {farm && farm.fields.length ? (
              <label className="ws-switch">
                <span>Field</span>
                <select aria-label="Selected field" value={field?.field_id ?? ""} onChange={(e) => selectField(e.target.value || null)}>
                  {!field ? <option value="">Choose a field</option> : null}
                  {farm.fields.map((f) => (
                    <option key={f.field_id} value={f.field_id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {sim.demo ? <span className="gf-demo-tag">{sim.demo}</span> : null}
          </div>
        </header>
        <main className="db-main ws-main gf-main">
          <SourceBanner source={api.source} />
          <StepHeader step={def} />
          {step === "farm" ? <StepFarm ctx={ctx} /> : null}
          {step === "now" && field ? <StepNow ctx={ctx} part={part} /> : null}
          {step === "simulate" && field ? <StepSimulate ctx={ctx} /> : null}
          {step === "try" && field ? <StepTry ctx={ctx} /> : null}
          {step === "compare" && field ? <StepCompare ctx={ctx} /> : null}
          {step === "plan" && field ? <StepPlan ctx={ctx} /> : null}
          {field && step !== "plan" ? <details className="db-card gf-reading-tools gf-no-print"><summary>Log a field reading</summary><ReadingsLog ctx={ctx} /></details> : null}
          {!field && step !== "farm" ? <Banner kind="info">Choose a field first.</Banner> : null}
          <footer className="gf-foot">
            {prevPart ? (
              <button type="button" className="btn btn-secondary" onClick={() => go("now", prevPart.id)}>
                Back: {prevPart.nav}
              </button>
            ) : prev ? (
              <button type="button" className="btn btn-secondary" onClick={() => go(prev.id, prev.id === "now" ? "losses" : "crops")}>
                Back: {prev.nav}
              </button>
            ) : (
              <span />
            )}
            {nextPart ? (
              <span className="gf-next">
                {!partReady ? <span className="gf-why">{partWhy[part]}</span> : null}
                <button type="button" className="btn btn-primary" disabled={!partReady} onClick={() => go("now", nextPart.id)}>
                  Next: {nextPart.nav}
                </button>
              </span>
            ) : next ? (
              <span className="gf-next">
                {nextBlocked ? <span className="gf-why">{!field ? "Draw a field or try a demo farm first." : "Complete your crops, dates and any money entries first."}</span> : null}
                <button type="button" className="btn btn-primary" disabled={nextBlocked} onClick={() => go(next.id)}>
                  Next: {next.nav}
                </button>
              </span>
            ) : null}
          </footer>
        </main>
      </div>
    </div>
  );
}
