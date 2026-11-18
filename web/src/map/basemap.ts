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

/** The web addresses (scheme and host) the base maps are fetched from. */
export function tileHosts(maps: Partial<Record<Basemap, BasemapSource>> = BASEMAPS): string[] {
  const hosts = new Set<string>();
  for (const m of Object.values(maps)) {
    for (const t of m?.tiles ?? []) {
      try {
        hosts.add(new URL(t.replace(/[{}]/g, "")).origin);
      } catch {
        // not an address: nothing to warm
      }
    }
  }
  return [...hosts];
}

/**
 * Opens the connection to the map's tile hosts ahead of the first tile, which saves the
 * handshake (a few hundred milliseconds on a slow line) when the map appears. It fetches
 * nothing: no tile, no place. Called when a grower is about to open the map, and by the map.
 */
export function warmTileHosts(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  warmHosts(tileHosts(), doc);
}

/** The same for any host the map draws pictures from (NASA's greenness and soil moisture pictures). */
export function warmHosts(origins: string[], doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc) return;
  for (const origin of origins) {
    if (doc.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) continue;
    const link = doc.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    link.crossOrigin = "anonymous";
    doc.head.appendChild(link);
  }
}

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
      // No fade: a tile is shown the moment it arrives.
      ...keys.map((k) => ({ id: layerId(k), type: "raster" as const, source: k, layout: { visibility: k === first ? ("visible" as const) : ("none" as const) }, paint: { "raster-fade-duration": 0 } })),
    ],
  };
}

/**
 * A base map is reported as failed once this many of its tiles have failed and failures are
 * more than twice the arrivals. (Not "none arrived": the browser may still hold a few tiles
 * from an earlier visit, which arrive while every new one is refused.)
 */
export const FAILED_TILES = 4;

/** Counts a base map's tiles as they arrive or fail, and says once when it is being refused. */
export function tileWatch(report: (b: Basemap) => void) {
  const seen: Partial<Record<Basemap, { ok: number; bad: number; told: boolean }>> = {};
  const of = (b: Basemap) => (seen[b] ??= { ok: 0, bad: 0, told: false });
  return {
    arrived: (b: Basemap) => {
      of(b).ok += 1;
    },
    failed: (b: Basemap) => {
      const s = of(b);
      s.bad += 1;
      if (s.bad >= FAILED_TILES && s.bad > s.ok * 2 && !s.told) {
        s.told = true;
        report(b);
      }
    },
  };
}
