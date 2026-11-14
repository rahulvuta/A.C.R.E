import { useEffect, useState } from "react";
import { generatePlans, goalsSchema, planSchema, type Plan, type PlanningField, type RecommendationCandidate } from "./api";
import { GoalsPanel, createGoalsPanelValue } from "./GoalsPanel";
import { Recommendations } from "./Recommendations";
import { FuturePlan } from "./FuturePlan";
import { readable, RequestError, usePlanningRequest } from "./shared";
import type { ReplayRequest } from "./api";
export interface PlanningFlowProps {
  location: {
    latitude: number;
    longitude: number;
  };
  field: PlanningField;
  onReplay?: (request: ReplayRequest) => void;
}
export function PlanningFlow(props: PlanningFlowProps) {
  return <PlanningFlowSession key={JSON.stringify([props.location, props.field])} {...props} />;
}
function PlanningFlowSession({
  location,
  field,
  onReplay
}: PlanningFlowProps) {
  const [value, setValue] = useState(() => ({
    ...createGoalsPanelValue(),
    crop_history: field.crop_history ?? []
  }));
  const [step, setStep] = useState<"goals" | "plans" | "future" | "manual">("goals");
  const [chosen, setChosen] = useState<RecommendationCandidate>();
  const [manualPlans, setManualPlans] = useState<Plan[]>();
  const [startSeason, setStartSeason] = useState(String(new Date().getFullYear() + 1));
  const [validation, setValidation] = useState("");
  const context = {
    ...field,
    crop_history: value.crop_history
  };
  const select = (candidate: RecommendationCandidate) => {
    setChosen(candidate);
    setManualPlans(undefined);
    setStep("future");
  };
  const goFind = () => {
    const count = value.crop_history.length;
    if (count > 3) {
      setValidation("Enter up to 3 previous crops, oldest first.");
      return;
    }
    const checked = goalsSchema.safeParse(value.goals);
    if (!checked.success) {
      setValidation(checked.error.issues.map(issue => `${issue.path.map(String).map(readable).join(" · ")}: ${issue.message}`).join(" "));
      return;
    }
    setValidation("");
    setStep("plans");
  };
  return <div className="pl pl-flow">
    <nav className="pl-steps pl-no-print" aria-label="Planning steps"><button aria-current={step === "goals" ? "step" : undefined} onClick={() => setStep("goals")}>1. Goals</button><button aria-current={step === "plans" ? "step" : undefined} onClick={goFind}>2. Find plans</button><button aria-current={step === "future" || step === "manual" ? "step" : undefined} disabled={!chosen && !manualPlans && step !== "manual"} onClick={() => setStep(manualPlans || chosen ? "future" : "manual")}>3. Future plan</button></nav>
    {step === "goals" && <form onSubmit={e => {
      e.preventDefault();
      goFind();
    }}><GoalsPanel value={value} onChange={setValue} />{validation && <p className="pl-error" role="alert">{validation}</p>}<div className="pl-actions"><button className="pl-button pl-primary" type="submit">Find plans for this field</button></div></form>}
    {step === "plans" && <Recommendations location={location} field={context} goals={value.goals} onUsePlan={select} onEditPlan={select} onPlanManually={() => setStep("manual")} onReplay={onReplay} />}
    {step === "manual" && <ManualPlanEditor seasons={value.goals.constraints.seasons} onUse={plans => {
      setManualPlans(plans);
      setChosen(undefined);
      setStep("future");
    }} />}
    {step === "future" && <><div className="pl-plan-controls pl-no-print"><button className="pl-text-button" onClick={() => setStep("plans")}>Back to options</button><label className="pl-input-label">First planting year<input type="number" min={1900} max={2200} value={startSeason} onChange={e => setStartSeason(e.target.value)} /></label></div>{manualPlans ? <FuturePlan location={location} plans={manualPlans} startSeason={startSeason} seasons={manualPlans.length} priorities={value.goals.priorities} onReplay={onReplay} /> : chosen && <ChosenFuture location={location} field={context} goals={value.goals} chosen={chosen} startSeason={startSeason} onReplay={onReplay} />}</>}
  </div>;
}
function ChosenFuture({
  location,
  field,
  goals,
  chosen,
  startSeason,
  onReplay
}: {
  location: PlanningFlowProps["location"];
  field: PlanningField;
  goals: ReturnType<typeof createGoalsPanelValue>["goals"];
  chosen: RecommendationCandidate;
  startSeason: string;
  onReplay?: (request: ReplayRequest) => void;
}) {
  const request = {
    location,
    field,
    goals
  };
  const {
    data,
    error,
    loading,
    retry
  } = usePlanningRequest(JSON.stringify([request, chosen.candidate_id]), async signal => {
    const result = await generatePlans(request, signal);
    const candidate = result.candidates.find(c => c.candidate_id === chosen.candidate_id);
    if (!candidate || JSON.stringify(candidate.seasons.map(s => planSchema.parse(s.plan))) !== JSON.stringify(chosen.plans.map(p => planSchema.parse(p)))) throw new Error("The original generated plan could not be matched. Return to options and find plans again so its date origins can be preserved.");
    return candidate;
  });
  if (loading) return <p className="pl-card" role="status">Loading the selected plan’s date sources…</p>;
  if (error) return <RequestError message={error} onRetry={retry} />;
  return data ? <FuturePlan location={location} candidate={data} startSeason={startSeason} seasons={goals.constraints.seasons} priorities={goals.priorities} onReplay={onReplay} /> : null;
}
const emptyPlan = (i: number): Plan => ({
  plan_id: `grower_season_${i + 1}`,
  previous_crop_id: "",
  prev_harvest: "",
  winter: {
    kind: "none"
  },
  next_crop_id: "",
  next_plant: ""
});
function ManualPlanEditor({
  seasons,
  onUse
}: {
  seasons: number;
  onUse: (plans: Plan[]) => void;
}) {
  const [plans, setPlans] = useState(() => Array.from({
    length: seasons
  }, (_, i) => emptyPlan(i)));
  const [management, setManagement] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setPlans(Array.from({
      length: seasons
    }, (_, i) => emptyPlan(i)));
    setManagement([]);
  }, [seasons]);
  const update = (i: number, patch: Partial<Plan>) => setPlans(current => current.map((p, index) => index === i ? {
    ...p,
    ...patch
  } : p));
  return <form className="pl-manual" onSubmit={e => {
    e.preventDefault();
    const result = planSchema.array().safeParse(plans);
    if (!result.success) {
      setError("Complete each crop and date as MM-DD. The service will check chronology and local guidance.");
      return;
    }
    setError("");
    onUse(result.data);
  }}><section className="pl-card"><h2>Plan manually</h2><p className="pl-muted">Enter your own dates and crops. Each season must begin with the previous season’s next crop.</p></section>{plans.map((p, i) => <section key={i} className="pl-card"><h3>Season {i + 1}</h3><div className="pl-form-grid">{(["previous_crop_id", "prev_harvest", "next_crop_id", "next_plant"] as const).map(key => <label className="pl-input-label" key={key}>{readable(key)}<input required value={p[key]} placeholder={key === "prev_harvest" || key === "next_plant" ? "MM-DD" : "Crop ID"} onChange={e => update(i, {
            [key]: e.target.value
          })} /></label>)}<label className="pl-input-label">Off-season management<select required value={management[i] ?? ""} onChange={e => {
            const kind = e.target.value as Plan["winter"]["kind"];
            setManagement(current => {
              const next = [...current];
              next[i] = kind;
              return next;
            });
            update(i, {
              winter: {
                kind
              }
            });
          }}><option value="" disabled>Choose management</option><option value="none">No winter crop</option><option value="cover">Cover crop</option><option value="winter_grain">Winter grain</option></select></label>{p.winter.kind !== "none" && (["crop_id", ...(p.winter.kind === "cover" ? ["seed", "terminate"] : ["plant", "harvest"])] as const).map(key => <label className="pl-input-label" key={key}>{readable(key)}<input required value={String(p.winter[key as keyof Plan["winter"]] ?? "")} placeholder={key === "crop_id" ? "Crop ID" : "MM-DD"} onChange={e => update(i, {
            winter: {
              ...p.winter,
              [key]: e.target.value
            }
          })} /></label>)}</div></section>)}{error && <p role="alert" className="pl-error">{error}</p>}<button className="pl-button pl-primary">Build my future plan</button></form>;
}
