import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import polygons from "../api/fixtures/polygons.json";
import { CompareResponse, SensitivityResponse, YearsResponse } from "../api/schema";
import years from "../../public/data/sample/years.json";
import compare from "../../public/data/sample/compare.json";
import sensitivity from "../../public/data/sample/sensitivity.json";
import type { FieldGeometry } from "../farm/types";
import { buildView } from "../view/build";
import FarmWorld, { type ScenePalette } from "./FarmWorld";
import { SCENE_SHAPE_LABEL } from "./polygonShape";

/*
  Dev-only page: the 3D farm with the sample plans. `?shapes=1` gives the three fields the
  L-shaped, holed and two-parcel fixture outlines (card C3); without it, the classic squares.
*/
const data = { years: YearsResponse.parse(years), compare: CompareResponse.parse(compare), sensitivity: SensitivityResponse.parse(sensitivity), origin: "saved" as const };
const view = buildView(data, { card: "cover", year: null });
const P = polygons.polygons as unknown as Record<string, { geometry: FieldGeometry }>;
const shapes = new URLSearchParams(location.search).get("shapes") === "1";
const outlines = shapes ? [P.pergamino_l!.geometry, P.pergamino_holed!.geometry, P.union_parcels!.geometry] : undefined;
const palette: ScenePalette = {
  cover: "#4FB56F", coverEnded: "#B9A36B", wheat: "#D2AE4E", wheatGreen: "#6E9E52", corn: "#C4A15C", cornGreen: "#5C9A44",
  soy: "#5E8C3A", soyMature: "#A88B4A", residue: "#E3D3A8", rain: "#0B6E86", action: "#004656", accent: "#2ADCEB", check: "#E08A1E", water: "#2AA8C4",
};
const day = Number(new URLSearchParams(location.search).get("day") ?? 100);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ position: "absolute", inset: 0 }}>
      {shapes ? <p style={{ position: "absolute", left: 16, top: 8, zIndex: 1 }}>{SCENE_SHAPE_LABEL}</p> : null}
      <Suspense fallback={null}>
        <FarmWorld strips={view.strips} day={day} preset="overview" animate={false} palette={palette} onSelect={() => {}} outlines={outlines} />
      </Suspense>
    </div>
  </StrictMode>,
);
