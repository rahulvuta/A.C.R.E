import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type { Farm } from "../farm/types";

/*
  The saved fields drawn on the map (one GeoJSON source, a fill and an outline). Each
  feature carries `field_id`, `selected` and `state`; C4 colours by `state`.
*/
export const FIELDS_SOURCE = "acre-fields";
export const FIELDS_FILL = "acre-fields-fill";
export const FIELDS_LINE = "acre-fields-line";

export type FieldState = "none" | "ready" | "pending" | "unavailable" | "flagged";

/** Colours per analysis state (kit tokens as hex, since MapLibre cannot read CSS vars). */
export const STATE_COLOR: Record<FieldState, string> = {
  none: "#2adceb", // accent: drawn, not analysed yet
  ready: "#0f7a8a", // teal: results ready
  pending: "#9aa5ab", // grey: weather being prepared
  unavailable: "#5f6b72", // dark grey: no result here
  flagged: "#d98b0b", // amber: has a check the grower can act on
};

export function ensureFieldLayers(map: MlMap) {
  if (map.getSource(FIELDS_SOURCE)) return;
  map.addSource(FIELDS_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const color = ["match", ["get", "state"], ...Object.entries(STATE_COLOR).flat(), STATE_COLOR.none] as unknown as string;
  map.addLayer({
    id: FIELDS_FILL,
    type: "fill",
    source: FIELDS_SOURCE,
    paint: { "fill-color": color, "fill-opacity": ["case", ["get", "selected"], 0.45, 0.28] },
  });
  map.addLayer({
    id: FIELDS_LINE,
    type: "line",
    source: FIELDS_SOURCE,
    paint: { "line-color": ["case", ["get", "selected"], "#ffffff", color] as unknown as string, "line-width": ["case", ["get", "selected"], 3, 2] },
  });
}

export function setFieldData(map: MlMap, farm: Farm | null, selectedId: string | null, states: Record<string, FieldState> = {}, hiddenId: string | null = null) {
  const src = map.getSource(FIELDS_SOURCE) as GeoJSONSource | undefined;
  if (!src) return;
  src.setData({
    type: "FeatureCollection",
    features: (farm?.fields ?? [])
      .filter((f) => f.field_id !== hiddenId)
      .map((f) => ({
        type: "Feature" as const,
        geometry: f.geometry,
        properties: { field_id: f.field_id, name: f.name, selected: f.field_id === selectedId, state: states[f.field_id] ?? "none" },
      })),
  });
}
