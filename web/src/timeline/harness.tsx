import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import type { FieldPlan } from "../farm/types";
import request from "./fixtures/simulate-union.request.json";
import response from "./fixtures/simulate-union.json";
import { TenYearTimeline, TimelineCompare, withRotations, type ScenarioResult } from "./index";

// Dev-only page: the U4 timeline on the example §11 response.
const scenarios = withRotations(response as unknown as { scenarios: ScenarioResult[] }, request as unknown as { scenarios: Array<{ scenario_id: string; rotation: FieldPlan[]; is_baseline?: boolean }> });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ display: "grid", gap: 24, padding: 24, background: "var(--surface-2)", minHeight: "100vh" }}>
      <TenYearTimeline scenario={scenarios[1]!} note={response.method.note} />
      <TimelineCompare scenarios={scenarios} note={response.method.note} />
    </main>
  </StrictMode>,
);
