import type { StyleSpecification } from "maplibre-gl";

/*
  Two keyless raster basemaps. Attribution is part of each source, and the map keeps the
  attribution control expanded so it is always visible (plan C1).
*/
export type Basemap = "satellite" | "streets";

export const BASEMAPS: Record<Basemap, { label: string; tiles: string[]; attribution: string; maxzoom: number }> = {
  satellite: {
    label: "Satellite",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxzoom: 19,
  },
  streets: {
    label: "Streets",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
};

export const layerId = (b: Basemap) => `basemap-${b}`;

/** Both basemaps live in one style; switching only flips visibility, so drawn layers survive. */
export function baseStyle(initial: Basemap): StyleSpecification {
  const keys = Object.keys(BASEMAPS) as Basemap[];
  return {
    version: 8,
    sources: Object.fromEntries(
      keys.map((k) => [k, { type: "raster" as const, tiles: BASEMAPS[k].tiles, tileSize: 256, maxzoom: BASEMAPS[k].maxzoom, attribution: BASEMAPS[k].attribution }]),
    ),
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#e8ecee" } },
      ...keys.map((k) => ({ id: layerId(k), type: "raster" as const, source: k, layout: { visibility: k === initial ? ("visible" as const) : ("none" as const) } })),
    ],
  };
}
