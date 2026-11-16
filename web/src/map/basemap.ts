import type { StyleSpecification } from "maplibre-gl";

/*
  The two base maps: a satellite photo and a street map. Attribution is part of each source,
  and the map keeps the attribution control expanded so it is always visible (plan C1).

  Where each comes from is a setting, not a fixed address (card 32), because both providers can
  change or withdraw free access and a public site may need a keyed service
  (docs/global/map-and-search-terms.md has what each provider asks). At build time:

    VITE_SATELLITE_TILES        a tile address with {z} {x} {y}, or "off" for no satellite photo
    VITE_SATELLITE_ATTRIBUTION  the credit that provider asks for
    VITE_STREET_TILES           a tile address with {z} {x} {y}
    VITE_STREET_ATTRIBUTION     the credit that provider asks for

  A new tile address without its own attribution shows no credit rather than the wrong one.
*/
export type Basemap = "satellite" | "streets";
export interface BasemapSource {
  label: string;
  tiles: string[];
  attribution: string;
  maxzoom: number;
}

const DEFAULTS: Record<Basemap, BasemapSource> = {
  satellite: {
    label: "Satellite",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Imagery © Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    maxzoom: 19,
  },
  streets: {
    label: "Streets",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
};

type Env = Record<string, string | undefined>;
const isTiles = (v: string) => /^https:\/\/\S+$/.test(v) && v.includes("{z}") && v.includes("{x}") && v.includes("{y}");

/** The base maps for a set of build settings. The street map is always there; the satellite photo can be switched off. */
export function basemapsFrom(env: Env): Partial<Record<Basemap, BasemapSource>> & { streets: BasemapSource } {
  const pick = (key: Basemap, tilesVar: string, creditVar: string): BasemapSource | null => {
    const tiles = (env[tilesVar] ?? "").trim();
    if (key === "satellite" && tiles.toLowerCase() === "off") return null;
    if (!isTiles(tiles)) return DEFAULTS[key];
    return { ...DEFAULTS[key], tiles: [tiles], attribution: (env[creditVar] ?? "").trim() };
  };
  const satellite = pick("satellite", "VITE_SATELLITE_TILES", "VITE_SATELLITE_ATTRIBUTION");
  const streets = pick("streets", "VITE_STREET_TILES", "VITE_STREET_ATTRIBUTION")!;
  return satellite ? { satellite, streets } : { streets };
}

export const BASEMAPS = basemapsFrom(import.meta.env as unknown as Env);
export const BASEMAP_KEYS = Object.keys(BASEMAPS) as Basemap[];
/** The map a visit opens on: the satellite photo when there is one. */
export const FIRST_BASEMAP: Basemap = BASEMAPS.satellite ? "satellite" : "streets";

export const layerId = (b: Basemap) => `basemap-${b}`;

/** Both basemaps live in one style; switching only flips visibility, so drawn layers survive. */
export function baseStyle(initial: Basemap, maps: Partial<Record<Basemap, BasemapSource>> = BASEMAPS): StyleSpecification {
  const keys = Object.keys(maps) as Basemap[];
  const first = keys.includes(initial) ? initial : keys[0];
  return {
    version: 8,
    sources: Object.fromEntries(
      keys.map((k) => [k, { type: "raster" as const, tiles: maps[k]!.tiles, tileSize: 256, maxzoom: maps[k]!.maxzoom, attribution: maps[k]!.attribution }]),
    ),
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#e8ecee" } },
      ...keys.map((k) => ({ id: layerId(k), type: "raster" as const, source: k, layout: { visibility: k === first ? ("visible" as const) : ("none" as const) } })),
    ],
  };
}
