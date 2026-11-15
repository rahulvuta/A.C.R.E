import { useEffect, useMemo, useState, type ReactNode } from "react";
import { APP_NAME } from "../../config";
import { GLOSSARY } from "../../content/glossary";
import { putFarm, selectField, useFarms, useSelectedField } from "../../farm/hooks";
import { fieldPoint, useFieldPlace } from "../../state/useFieldPlace";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { loadDemoFields, useSimField } from "../../state/simField";
import { peekSimulation } from "../../state/useSimulation";
import { Banner, Term } from "../../ui/components";
import { navIcon } from "../planner/SideNav";
import { SourceBanner } from "../workspace/Workspace";
import { rotationReady, simulateRequest, type StepContext } from "./context";
import { STEPS, stepIndex, type StepDef, type StepId } from "./steps";
import { StepFarm } from "./StepFarm";
import { StepNow } from "./StepNow";
import { StepSimulate } from "./StepSimulate";
import { StepTry } from "./StepTry";
import { StepCompare } from "./StepCompare";
import { StepPlan } from "./StepPlan";

/*
  The Scenario Simulator's guided flow (card U1, docs/global/simulator.md): Your farm → What
  you do now → Simulate current plan → Try other plans → Compare → Your 10-year plan. The
  sidebar shows progress; each step asks one question. State is kept per field in the browser
  (state/simField.ts). The older NC dashboard stays under "Union County deep-dive".
*/
export const DEEP_DIVE_HREF = "?view=demo";

function readStep(): StepId {
  const m = window.location.hash.match(/[#&]u=([a-z]+)/);
  const s = m?.[1] as StepId | undefined;
  return s && STEPS.some((x) => x.id === s) ? s : "farm";
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
  const go = (s: StepId) => {
    setStepState(s);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#u=${s}`);
    window.scrollTo?.({ top: 0 });
  };
  const place = useFieldPlace(api.client, field);
  const profile = place?.profile.state === "ready" ? place.profile.data : null;
  const regionKey = profile?.regionKey ?? (place?.place.state === "ready" ? (place.place.data.regionKeys[0] ?? null) : null);
  // The simulation uses the field's own centre; the profile lookup above uses a rounded one.
  const point = useMemo(() => (field ? fieldPoint(field) : null), [field]);
  const ctx: StepContext = { api, farm, field, sim, point, regionKey, profile, go };

  useEffect(() => {
    const on = () => setStepState(readStep());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // A step past "Your farm" needs a field.
  useEffect(() => {
    if (!field && step !== "farm") setStepState("farm");
  }, [field, step]);

  const baseReq = simulateRequest(ctx, []);
  const fullReq = simulateRequest(ctx, sim.scenarios);
  const done: Record<StepId, boolean> = {
    farm: Boolean(farm?.fields.length),
    now: rotationReady(sim.rotation),
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
                <button type="button" aria-current={step === s.id ? "step" : undefined} disabled={!reachable(s.id)} onClick={() => go(s.id)} data-done={done[s.id] ? "yes" : "no"}>
                  <span className="gf-dot" aria-hidden="true">
                    {done[s.id] ? "✓" : s.n}
                  </span>
                  <span>{s.nav}</span>
                  <span className="sr-only">{done[s.id] ? " (done)" : ""}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="db-side-foot">
          <div className="db-links">
            <a href={DEEP_DIVE_HREF}>
              {navIcon("M3 8l6-5 6 5v7H3zM7.500 15v-4h3v4")}
              Union County deep-dive
            </a>
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
          {step === "now" && field ? <StepNow ctx={ctx} /> : null}
          {step === "simulate" && field ? <StepSimulate ctx={ctx} /> : null}
          {step === "try" && field ? <StepTry ctx={ctx} /> : null}
          {step === "compare" && field ? <StepCompare ctx={ctx} /> : null}
          {step === "plan" && field ? <StepPlan ctx={ctx} /> : null}
          {!field && step !== "farm" ? <Banner kind="info">Choose a field first.</Banner> : null}
          <footer className="gf-foot">
            {prev ? (
              <button type="button" className="btn btn-secondary" onClick={() => go(prev.id)}>
                Back: {prev.nav}
              </button>
            ) : (
              <span />
            )}
            {next ? (
              <span className="gf-next">
                {nextBlocked ? <span className="gf-why">{!field ? "Draw a field or try a demo farm first." : "Complete every crop and date in your current plan first."}</span> : null}
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
