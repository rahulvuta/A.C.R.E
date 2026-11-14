import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import { PlanningFlow } from "./index";
createRoot(document.getElementById("root")!).render(<StrictMode><div className="pl pl-dashboard"><aside className="pl-sidebar pl-no-print"><a className="pl-brand" href="/src/planning/harness.html">A.C.R.E</a><p>Field planning</p><span className="pl-sidebar-active">Plan a rotation</span><small>Historical evidence.<br />Your priorities.</small></aside><div className="pl-dashboard-main"><header className="pl-topbar"><span>Union County, North Carolina</span><span>Demonstration field</span></header><main className="pl-main"><div className="pl-page-heading"><h1>Plan this field.<br /><span>Your goals come first.</span></h1><p>Compare rotation options, then work through a dated plan.</p></div><PlanningFlow location={{
          latitude: 34.98,
          longitude: -80.55
        }} field={{
          field_id: "planning_demo",
          crop_history: ["field_corn"],
          soil: null
        }} /></main></div></div></StrictMode>);
