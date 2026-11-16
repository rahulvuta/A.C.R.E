import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/layout.css";
import "../styles/acre.css";
import { trackInputMode } from "../ui/inputMode";
import { createFetchGeoApi } from "./geoApi";
import { FarmMap } from "./FarmMap";
import type { FieldState } from "./fieldLayers";
import type { WeatherCellView } from "./weatherCells";
import { useSelectedField } from "../farm/hooks";

// Dev-only page for the map's Playwright specs. `?api=` picks the backend (tests mock it).
trackInputMode();
const base = new URLSearchParams(window.location.search).get("api") ?? "http://localhost:8000";
const api = createFetchGeoApi(base);

type Results = { states: Record<string, FieldState>; cells: WeatherCellView[] };
type W = { __map: unknown; __setResults?: (r: Results) => void };

// Tests feed analysis results through `window.__setResults` (C4), standing in for D's analysis.
function Harness() {
  const [r, setR] = useState<Results>({ states: {}, cells: [] });
  useEffect(() => {
    (window as unknown as W).__setResults = setR;
  }, []);
  const sel = useSelectedField();
  return (
    <>
      <FarmMap api={api} fieldStates={r.states} weatherCells={r.cells} onMapReady={(m) => ((window as unknown as W).__map = m)} />
      {/* What D's screens would read: the selected field. */}
      <output data-testid="selected-field" hidden>{sel?.field_id ?? ""}</output>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
