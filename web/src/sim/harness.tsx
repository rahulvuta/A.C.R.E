import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ScenarioCompare, ScenarioResults } from "./index";
import { partialSimulationExample, simulationExample } from "./fixtures";

function Harness() {
  const [partial, setPartial] = useState(false);
  const [mode, setMode] = useState("compare");
  const [selectedId, setSelectedId] = useState("current");
  const [choice, setChoice] = useState<string>();
  const result = partial ? partialSimulationExample : simulationExample;
  const selected = result.scenarios.find(s => s.scenario_id === selectedId) ?? result.scenarios[0]!;
  return <div className="sim sim-harness"><aside><a href="/src/sim/harness.html">A.C.R.E</a><p>Scenario examples</p><p>Historical evidence.<br />Your priorities.</p></aside><div className="sim-harness-content"><header className="sim-harness-top"><span>Union County, North Carolina</span><span>Example field · synthetic values</span></header><div className="sim-harness-controls"><label>View<select value={mode} onChange={e => setMode(e.target.value)}><option value="compare">Compare plans</option><option value="results">Simulation results</option></select></label>{mode === "results" && <label>Plan<select value={selectedId} onChange={e => setSelectedId(e.target.value)}>{result.scenarios.map(s => <option key={s.scenario_id} value={s.scenario_id}>{s.label}</option>)}</select></label>}<label><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} />Show missing-money example</label></div>{choice && <p role="status" className="sim-harness-status">Example choice: {result.scenarios.find(s => s.scenario_id === choice)?.label}. No plan is saved or sent.</p>}<main>{mode === "compare" ? <ScenarioCompare result={result} baselineId="current" onChoose={setChoice} /> : <ScenarioResults scenario={selected} />}</main></div></div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
