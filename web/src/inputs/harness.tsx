import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AreaSummary, CropPicker, EconomicsEditor, EquipmentEditor, PlanEditor, ReadingsLog, createEconomicsValue, createPlanEditorValue, inputsApi, type Crop, type Reading } from "./index";
import { EXAMPLE_LABEL, createExampleInputsApi, exampleCrops, exampleLocation, examplePlan, exampleReadings } from "./examples";

const exampleApi = createExampleInputsApi();
function Harness() {
  const [live, setLive] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(exampleCrops[1]!);
  const [plan, setPlan] = useState(examplePlan);
  const [economics, setEconomics] = useState(createEconomicsValue);
  const [equipment, setEquipment] = useState<string[]>(["planter", "grain_drill", "combine"]);
  const [readings, setReadings] = useState<Reading[]>(exampleReadings);
  const [areaHa, setAreaHa] = useState<number | null>(16.2);
  const api = live ? inputsApi : exampleApi;
  const cropIds = [...new Set([plan.plan.previous_crop_id, plan.plan.winter.kind === "none" ? null : plan.plan.winter.crop_id, plan.plan.next_crop_id].filter((id): id is string => !!id))];
  return <div className="acre-inputs"><header><h1>A.C.R.E <span className="acre-input-muted">Farmer inputs</span></h1></header><main>
    <div className="acre-input-example"><strong>{live ? "Live service · example form inputs" : "Example mode"}</strong><p>{EXAMPLE_LABEL}</p><p>Research example: search for okra, then choose “Research 'okra' with AI”. Values reset when this page reloads.</p><label>Service<select value={live ? "live" : "example"} onChange={event => setLive(event.target.value === "live")}><option value="example">Example fixtures (no network)</option><option value="live">Live API (VITE_API_BASE or localhost:8000)</option></select></label><button type="button" onClick={() => { setCrop(null); setPlan(createPlanEditorValue()); setEconomics(createEconomicsValue()); setEquipment([]); setReadings([]); setAreaHa(null); }}>Start with blank inputs</button></div>
    <div className="acre-input-harness-grid"><div className="acre-input-card"><label>Field hectares (display example)<input type="number" step="any" min="0" value={areaHa ?? ""} placeholder="Not available" onChange={event => setAreaHa(event.target.value === "" ? null : Number(event.target.value))} /></label><AreaSummary areaHa={areaHa} /></div><div className="acre-input-card"><h2>Crop library</h2><CropPicker regionKey="US-NC" value={crop} onChange={setCrop} api={api} /></div></div>
    <PlanEditor location={exampleLocation} regionKey="US-NC" value={plan} onChange={setPlan} api={api} />
    <EconomicsEditor location={exampleLocation} crops={cropIds} area={{ value: areaHa, unit: "ha" }} value={economics} onChange={setEconomics} api={api} />
    <div className="acre-input-harness-grid"><EquipmentEditor value={equipment} onChange={setEquipment} api={api} /><ReadingsLog value={readings} onChange={setReadings} /></div>
  </main></div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
