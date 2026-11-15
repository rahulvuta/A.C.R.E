import * as THREE from "three";
import type { FieldGeometry } from "../farm/types";

/*
  A drawn field outline turned into stage shapes for the 3D view (card C3). Each ring is
  projected to a local east-north plane around the field's centre (metres, equirectangular,
  fine at field size), then scaled uniformly so the whole field fits the stage square and is
  centred on it. Shape x is east, shape y is north; holes stay holes. This is an illustration
  of the drawing's shape, not a survey: the 3D view never shows metres.
*/
export const SCENE_SHAPE_LABEL = "Shape from your drawing; an illustration of planned dates";

const M_PER_DEG = 111_320;

export interface StageShape {
  shapes: THREE.Shape[];
  /** Stage-unit rings (outer first, then holes) per parcel, for point-in-shape tests. */
  rings: Array<Array<Array<[number, number]>>>;
}

function parts(g: FieldGeometry): number[][][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/** Fit the outline into a stageW × stageD square (with a small margin). Null when unusable. */
export function stageShape(g: FieldGeometry | null | undefined, stageW: number, stageD: number, margin = 0.92): StageShape | null {
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) return null;
  const polys = parts(g).filter((p) => p.length > 0 && p[0]!.length >= 4);
  if (polys.length === 0) return null;
  const outer = polys.flatMap((p) => p[0]!);
  // Longitudes unwrapped against the first point so a field across 180° stays together.
  const lon0 = outer[0]![0]!;
  const unwrap = (lon: number) => lon0 + ((((lon - lon0 + 540) % 360) + 360) % 360) - 180;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [lon, lat] of outer) {
    const u = unwrap(lon!);
    minX = Math.min(minX, u); maxX = Math.max(maxX, u); minY = Math.min(minY, lat!); maxY = Math.max(maxY, lat!);
  }
  const cLon = (minX + maxX) / 2;
  const cLat = (minY + maxY) / 2;
  const kx = M_PER_DEG * Math.cos((cLat * Math.PI) / 180);
  const wM = (maxX - minX) * kx;
  const dM = (maxY - minY) * M_PER_DEG;
  if (!(wM > 0) || !(dM > 0)) return null;
  const s = Math.min((stageW * margin) / wM, (stageD * margin) / dM);
  const proj = (p: number[]): [number, number] => [(unwrap(p[0]!) - cLon) * kx * s, (p[1]! - cLat) * M_PER_DEG * s];

  const rings = polys.map((poly) => poly.map((ring) => ring.slice(0, -1).map(proj)));
  const shapes = rings.map(([outerRing, ...holes]) => {
    const shape = new THREE.Shape(outerRing!.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    return shape;
  });
  return { shapes, rings };
}

function inRing(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is a stage point (x east, y north) inside the field and outside its holes? */
export function insideStage(st: StageShape, x: number, y: number): boolean {
  return st.rings.some(([outerRing, ...holes]) => inRing(x, y, outerRing!) && !holes.some((h) => inRing(x, y, h)));
}

/**
 * One soil layer as an extruded slab, lying flat: the shape's north points away from the
 * camera (-z) and the slab runs from y = 0 up to y = depth. Callers place it at the layer's bottom.
 */
export function slabGeometry(st: StageShape, depth: number): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(st.shapes, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** One field of a farm layout: its outline around its own centre, and where that centre sits on the stage. */
export interface PlacedShape {
  shape: StageShape;
  /** Stage position of the field's centre: x east, z south (north is -z). */
  x: number;
  z: number;
}

export interface FarmLayout {
  fields: Array<PlacedShape | null>;
  /** Half extents of the whole farm on the stage, for framing the camera. */
  halfW: number;
  halfD: number;
}

/**
 * Every field of a farm on one stage, at one shared scale, so shapes, sizes and the gaps
 * between fields match the map. The farm fits a stageW × stageD box and no single field is
 * wider or deeper than maxField (so per-field details sized for the classic square still fit).
 * Still an illustration of the drawing: the view never shows metres.
 */
export function farmLayout(geoms: Array<FieldGeometry | null | undefined>, stageW: number, stageD: number, maxField: number, margin = 0.92): FarmLayout | null {
  const polysOf = (g: FieldGeometry | null | undefined) =>
    g && (g.type === "Polygon" || g.type === "MultiPolygon") ? parts(g).filter((p) => p.length > 0 && p[0]!.length >= 4) : [];
  const all = geoms.flatMap((g) => polysOf(g).flatMap((p) => p[0]!));
  if (all.length === 0) return null;
  const lon0 = all[0]![0]!;
  const unwrap = (lon: number) => lon0 + ((((lon - lon0 + 540) % 360) + 360) % 360) - 180;
  const box = (pts: number[][]) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [lon, lat] of pts) {
      const u = unwrap(lon!);
      minX = Math.min(minX, u); maxX = Math.max(maxX, u); minY = Math.min(minY, lat!); maxY = Math.max(maxY, lat!);
    }
    return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  };
  const farm = box(all);
  const kx = M_PER_DEG * Math.cos((farm.cy * Math.PI) / 180);
  const wM = (farm.maxX - farm.minX) * kx;
  const dM = (farm.maxY - farm.minY) * M_PER_DEG;
  const boxes = geoms.map((g) => {
    const outer = polysOf(g).flatMap((p) => p[0]!);
    return outer.length ? box(outer) : null;
  });
  let biggest = 0;
  for (const b of boxes) if (b) biggest = Math.max(biggest, (b.maxX - b.minX) * kx, (b.maxY - b.minY) * M_PER_DEG);
  if (!(biggest > 0)) return null;
  const s = Math.min(wM > 0 ? (stageW * margin) / wM : Infinity, dM > 0 ? (stageD * margin) / dM : Infinity, (maxField * margin) / biggest);
  const fields = geoms.map((g, i): PlacedShape | null => {
    const b = boxes[i];
    if (!b || !((b.maxX - b.minX) * (b.maxY - b.minY) > 0)) return null;
    const proj = (p: number[]): [number, number] => [(unwrap(p[0]!) - b.cx) * kx * s, (p[1]! - b.cy) * M_PER_DEG * s];
    const rings = polysOf(g).map((poly) => poly.map((ring) => ring.slice(0, -1).map(proj)));
    const shapes = rings.map(([outerRing, ...holes]) => {
      const shape = new THREE.Shape(outerRing!.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
      return shape;
    });
    return { shape: { shapes, rings }, x: (b.cx - farm.cx) * kx * s, z: -(b.cy - farm.cy) * M_PER_DEG * s };
  });
  return { fields, halfW: (wM * s) / 2, halfD: (dM * s) / 2 };
}
