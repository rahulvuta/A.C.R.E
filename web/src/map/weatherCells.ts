import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";

/*
  The NASA weather cells behind a farm's analysis (card C4). The backend gives each cell's
  centre and size (`weather_cells[].cell`, contract §5); the map only draws that rectangle.
  Fields in one cell share one weather series, so their differences come from their plans.
*/
export interface WeatherCellView {
  cellId: string;
  center: { latitude: number; longitude: number };
  /** [lat, lon] degrees, as the backend sends it (0.5 × 0.625 for NASA POWER). */
  sizeDeg: [number, number];
  fieldIds: string[];
  /** The backend's note for this cell, shown as given. */
  note?: string | null;
}

export const CELL_LABEL = "one NASA weather series";
export const SHARED_NOTICE = "These fields share one NASA weather series; differences between them come from their plans, not their weather.";

export const CELLS_SOURCE = "acre-cells";
export const CELLS_LINE = "acre-cells-line";
export const CELLS_FILL = "acre-cells-fill";

export function cellRing(c: WeatherCellView): number[][] {
  const [dLat, dLon] = c.sizeDeg;
  const s = c.center.latitude - dLat / 2;
  const n = c.center.latitude + dLat / 2;
  const w = c.center.longitude - dLon / 2;
  const e = c.center.longitude + dLon / 2;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

/** Adds the cell layers under the field layers (call before ensureFieldLayers, or pass `before`). */
export function ensureCellLayers(map: MlMap, before?: string) {
  if (map.getSource(CELLS_SOURCE)) return;
  map.addSource(CELLS_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const b = before && map.getLayer(before) ? before : undefined;
  map.addLayer({ id: CELLS_FILL, type: "fill", source: CELLS_SOURCE, paint: { "fill-color": "#ffffff", "fill-opacity": 0.06 } }, b);
  map.addLayer({ id: CELLS_LINE, type: "line", source: CELLS_SOURCE, paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [3, 2] } }, b);
}

export function setCellData(map: MlMap, cells: WeatherCellView[]) {
  const src = map.getSource(CELLS_SOURCE) as GeoJSONSource | undefined;
  if (!src) return;
  src.setData({
    type: "FeatureCollection",
    features: cells.map((c) => ({ type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [cellRing(c)] }, properties: { cell_id: c.cellId, fields: c.fieldIds.length } })),
  });
}
