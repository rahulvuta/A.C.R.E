import { useId, useState, type KeyboardEvent } from "react";
import { app, Chevron, to, whole, type Numbers } from "./Site";

const stages = [
  { label: "Your field", title: "Start with the ground you know.", detail: "Find your farm anywhere on the map. Draw a boundary for each field." },
  { label: "Your goals", title: "Tell the planner what matters.", detail: "Set priorities, crop preferences and the limits you work within." },
  { label: "Your options", title: "A shortlist, with the reasons.", detail: "Compare generated rotations by named indicators, trade-offs and local evidence." },
  { label: "Your future plan", title: "See how the seasons connect.", detail: "Carry your chosen rotation into planting windows, field jobs and decision dates." },
];

/** A schematic of the planning flow, with no sample results or invented farm data. */
export function PlanningPreview() {
  const [stage, setStage] = useState(0);
  const id = useId();
  const selectWithKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % stages.length
      : event.key === "ArrowLeft" ? (index + stages.length - 1) % stages.length
      : event.key === "Home" ? 0 : event.key === "End" ? stages.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setStage(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  return (
    <div className="st-plan-preview">
      <div className="st-preview-top"><span>A.C.R.E / Field planning</span><span>Workflow illustration</span></div>
      <div className="st-preview-tabs" role="tablist" aria-label="Explore the planning workflow">
        {stages.map((item, index) => (
          <button key={item.label} id={`${id}-tab-${index}`} type="button" role="tab"
            aria-selected={stage === index} aria-controls={`${id}-panel`} tabIndex={stage === index ? 0 : -1}
            onClick={() => setStage(index)} onKeyDown={(event) => selectWithKeys(event, index)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="st-preview-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${stage}`} tabIndex={0}>
        <div className="st-preview-art" key={stage}>
          {stage === 0 ? (
            <div className="st-field-sketch">
              <p>Draw the field you want to plan</p>
              <svg viewBox="0 0 500 250" role="img" aria-label="Illustrated field boundaries, with one field selected">
                <path className="st-sketch-land" d="M-20 45L170 15 260 80 235 265H-20ZM285-10L520-10V155L310 130Z" />
                <path className="st-sketch-road" d="M-20 225L200 185 295 165 520 195M250-20L265 80 295 165 305 270" />
                <path className="st-sketch-field" d="M66 71L175 49 233 94 214 160 78 186 49 128Z" />
                {[[66, 71], [175, 49], [233, 94], [214, 160], [78, 186], [49, 128]].map(([cx, cy]) => <rect key={`${cx}-${cy}`} x={cx! - 3} y={cy! - 3} width="6" height="6" />)}
                <text x="137" y="125" textAnchor="middle">Your field</text>
                <text className="st-sketch-muted" x="390" y="90" textAnchor="middle">Another field</text>
              </svg>
              <span className="st-sketch-caption">Each boundary has its own rotation.</span>
            </div>
          ) : stage === 1 ? (
            <div className="st-preview-goals">
              <p className="st-preview-label">What matters on this field?</p>
              {["Soil cover", "Crop diversity", "Management simplicity"].map((label) => (
                <div key={label}><span>{label}</span><span className="st-goal-line" /></div>
              ))}
              <p>Crop history, equipment and date limits shape the options.</p>
            </div>
          ) : stage === 2 ? (
            <div className="st-preview-options">
              <p className="st-preview-label">Read each option in context</p>
              <dl>
                <div><dt>Why consider it?</dt><dd>Indicators that match your priorities</dd></div>
                <div><dt>What changes?</dt><dd>Cover, timing and field operations</dd></div>
                <div><dt>What needs a check?</dt><dd>Trade-offs, evidence gaps and uncertainty</dd></div>
              </dl>
            </div>
          ) : (
            <div className="st-preview-seasons">
              <p className="st-preview-label">A rotation you can carry forward</p>
              <div><span>Planting window</span><span>Cover schedule</span><span>Next crop</span></div>
              <p>Field jobs and decision dates, season by season.</p>
              <span className="st-preview-source">Sourced dates · Your dates · Assumptions</span>
            </div>
          )}
        </div>
        <div className="st-preview-caption"><strong>{stages[stage]!.title}</strong><p>{stages[stage]!.detail}</p></div>
      </div>
      <div className="st-preview-base"><span>Local guidance</span><span>NASA weather history</span><span>Your priorities</span></div>
    </div>
  );
}

export function PlanningSteps() {
  return (
    <ol className="st-planning-steps">
      {[
        ["Locate & draw", "Find your farm. Make each field your own starting point."],
        ["Set your goals", "Choose priorities and add crops, history, equipment and date limits."],
        ["Explore rotations", "Get generated options shortlisted against NASA history and local guidance."],
        ["Plan ahead", "Take a chosen rotation into a future plan across seasons."],
      ].map(([title, text], index) => (
        <li key={title}><span className="st-step-number">0{index + 1}</span><h3>{title}</h3><p>{text}</p></li>
      ))}
    </ol>
  );
}

/** All values refer to the saved Union County example, never to global coverage. */
export function RecordFacts({ n }: { n: Numbers }) {
  return (
    <dl className="st-record-facts">
      {[
        { value: whole(n.springs), unit: "past springs", label: `${n.firstYear ?? "…"}–${n.lastYear ?? "…"} · Union County`, href: app("pg=springs") },
        { value: whole(n.bareNow), unit: "mm", label: "Winter rain on bare ground · no planted cover", href: app("s=current&pg=plan") },
        { value: whole(n.bareCover), unit: "mm", label: "Same winter · cereal rye before soybeans", href: app("s=cover&pg=plan") },
        { value: n.checks == null || n.of == null ? "Not available" : `${n.checks} of ${n.of}`, unit: "springs", label: "Soil-moisture check flagged · rye plan", href: app("s=cover&pg=springs") },
      ].map((fact) => (
        <div key={fact.label}><dt>{fact.label}</dt><dd><a href={fact.href}>{fact.value}<span>{fact.unit}</span><Chevron /></a></dd></div>
      ))}
    </dl>
  );
}

export function EvidencePrinciples() {
  return (
    <div className="st-principles">
      {[
        ["History as context", "NASA POWER weather supports the comparison. Coverage is reported for the selected location."],
        ["Guidance for that place", "Regional sources shape the rotation options. NC guidance belongs to the NC worked example."],
        ["Reasons you can inspect", "The shortlist names its indicators, trade-offs and uncertainties. Your priorities order the options."],
        ["Gaps stay visible", "When evidence is too thin to generate rotations, the planner shows the gaps instead of guessing."],
      ].map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}
    </div>
  );
}

export function ExampleLink() {
  return <a className="st-link" href={to("evidence")}>Explore the Union County evidence <Chevron /></a>;
}

export function RecordPlaceholder({ failed, ratio = "1400 / 880" }: { failed: boolean; ratio?: string }) {
  return (
    <div className="st-skeleton" role="status" style={{ aspectRatio: ratio }}>
      {failed ? <div><p>The saved example could not be loaded.</p><a className="st-link" href="?view=demo">Open the NC demo to retry <Chevron /></a></div> : "Loading the worked example…"}
    </div>
  );
}
