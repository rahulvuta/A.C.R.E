import type { Map as MlMap } from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, type GeoJSONStoreFeatures } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { fromParcels, parcels, type Ring } from "../farm/geometry";
import type { FieldGeometry } from "../farm/types";

/*
  terra-draw on the MapLibre map. terra-draw edits single rings only (no holes, no
  multipolygons), so a field is loaded as one terra-draw polygon per ring (outer outlines
  and cut-outs alike) and rebuilt from them when editing is done. The farm store stays the
  source of truth; terra-draw holds only what is being drawn or edited right now.
*/
const ACCENT = "#2adceb";
const TEAL = "#004656";
const WHITE = "#ffffff";

export type DrawMode = "static" | "polygon" | "select";

export interface Drawing {
  setMode(m: DrawMode): void;
  /** Called once with the finished ring when a polygon is completed in polygon mode. */
  onFinish(fn: ((ring: Ring) => void) | null): void;
  /** Load a field's rings for editing. */
  loadForEdit(g: FieldGeometry): void;
  /** Rebuild the edited field from the rings in terra-draw. */
  collectEdit(): FieldGeometry | null;
  clear(): void;
  destroy(): void;
}

export function createDrawing(map: MlMap): Drawing {
  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [
      new TerraDrawPolygonMode({
        styles: { fillColor: ACCENT, fillOpacity: 0.25, outlineColor: TEAL, outlineWidth: 2, closingPointColor: WHITE, closingPointOutlineColor: TEAL, closingPointWidth: 6, closingPointOutlineWidth: 2 },
      }),
      new TerraDrawSelectMode({
        flags: {
          polygon: {
            feature: {
              draggable: true,
              coordinates: { midpoints: true, draggable: true, deletable: true },
            },
          },
        },
        styles: {
          selectedPolygonColor: ACCENT,
          selectedPolygonFillOpacity: 0.3,
          selectedPolygonOutlineColor: TEAL,
          selectionPointColor: WHITE,
          selectionPointOutlineColor: TEAL,
          midPointColor: ACCENT,
          midPointOutlineColor: TEAL,
        },
      }),
    ],
  });
  draw.start();
  draw.setMode("static");

  let finishFn: ((ring: Ring) => void) | null = null;
  // Which parcel and ring each loaded terra-draw feature came from.
  let editRings = new Map<string | number, { part: number; ring: number }>();

  draw.on("finish", (id, ctx) => {
    if (draw.getMode() !== "polygon" || (ctx && ctx.action !== "draw")) return;
    const f = draw.getSnapshotFeature(id);
    draw.removeFeatures([id]);
    if (!f || f.geometry.type !== "Polygon") return;
    finishFn?.((f.geometry.coordinates[0] as Ring).map((p) => [p[0]!, p[1]!] as [number, number]));
  });

  return {
    setMode(m) {
      draw.setMode(m);
    },
    onFinish(fn) {
      finishFn = fn;
    },
    loadForEdit(g) {
      draw.clear();
      editRings = new Map();
      const features: GeoJSONStoreFeatures[] = [];
      parcels(g).forEach((poly, part) =>
        poly.forEach((ring, r) => {
          const id = globalThis.crypto.randomUUID();
          editRings.set(id, { part, ring: r });
          features.push({ id, type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { mode: "polygon" } });
        }),
      );
      const results = draw.addFeatures(features);
      // terra-draw may refuse a ring (e.g. too small); leave it out rather than lose the rest silently.
      for (const res of results) if (!res.valid) editRings.delete(res.id as string);
      draw.setMode("select");
    },
    collectEdit() {
      const polys: number[][][][] = [];
      const snapshot = new Map(draw.getSnapshot().map((f) => [f.id!, f]));
      const entries = [...editRings.entries()].sort((a, b) => a[1].part - b[1].part || a[1].ring - b[1].ring);
      for (const [id, { part, ring }] of entries) {
        const f = snapshot.get(id);
        if (!f || f.geometry.type !== "Polygon") continue;
        const coords = f.geometry.coordinates[0] as number[][];
        if (ring === 0) polys[part] = [coords];
        else if (polys[part]) polys[part]!.push(coords);
      }
      const kept = polys.filter(Boolean);
      return kept.length ? fromParcels(kept) : null;
    },
    clear() {
      draw.clear();
      editRings = new Map();
      draw.setMode("static");
    },
    destroy() {
      try {
        draw.stop();
      } catch {
        /* the map may already be gone */
      }
    },
  };
}
