import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/layout.css";
import "../styles/fieldback.css";
import { trackInputMode } from "../ui/inputMode";
import { createFetchGeoApi } from "./geoApi";
import { FarmMap } from "./FarmMap";

// Dev-only page for the map's Playwright specs. `?api=` picks the backend (tests mock it).
trackInputMode();
const base = new URLSearchParams(window.location.search).get("api") ?? "http://localhost:8000";
const api = createFetchGeoApi(base);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FarmMap api={api} onMapReady={(m) => ((window as unknown as { __map: unknown }).__map = m)} />
  </StrictMode>,
);
