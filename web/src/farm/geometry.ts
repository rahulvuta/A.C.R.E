import turfArea from "@turf/area";
import turfCentroid from "@turf/centroid";
import kinks from "@turf/kinks";
import type { FieldGeometry } from "./types";

/*
  Display-only geometry for fields (plan C2): geodesic area with turf, a centroid for labels,
  and shape checks. The backend recomputes area and centroid for any calculation.
*/
export type Position = [number, number];
export type Ring = Position[];

export const SQ_M_PER_HA = 10_000;
export const SQ_M_PER_AC = 4046.8564224;

/** Every polygon of a field, as rings (outer first, then holes). */
export function parcels(g: FieldGeometry): number[][][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/** A Polygon for one parcel, a MultiPolygon for several. */
export function fromParcels(polys: number[][][][]): FieldGeometry {
  if (polys.length === 1) return { type: "Polygon", coordinates: polys[0]! };
  return { type: "MultiPolygon", coordinates: polys };
}

export function areaM2(g: FieldGeometry): number {
  return turfArea({ type: "Feature", properties: {}, geometry: g });
}

export function areaHa(g: FieldGeometry): number {
  return areaM2(g) / SQ_M_PER_HA;
}

export function areaAc(g: FieldGeometry): number {
  return areaM2(g) / SQ_M_PER_AC;
}

/** "101.3 ha · 250.3 ac" with sensible precision for small and large fields. */
export function formatArea(g: FieldGeometry): { ha: string; ac: string } {
  const m2 = areaM2(g);
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  return { ha: `${fmt(m2 / SQ_M_PER_HA)} ha`, ac: `${fmt(m2 / SQ_M_PER_AC)} ac` };
}

export function centroid(g: FieldGeometry): { latitude: number; longitude: number } {
  const c = turfCentroid({ type: "Feature", properties: {}, geometry: g }).geometry.coordinates;
  return { latitude: c[1]!, longitude: c[0]! };
}

export function bbox(g: FieldGeometry): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of parcels(g)) for (const ring of poly) for (const [x, y] of ring as Position[]) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

const isPos = (p: unknown): p is Position =>
  Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number" && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/** Close a ring if its last point is not its first. */
export function closeRing(r: Ring): Ring {
  if (r.length === 0) return r;
  const a = r[0]!, b = r[r.length - 1]!;
  return a[0] === b[0] && a[1] === b[1] ? r : [...r, a];
}

/** Ray casting; points on the edge count as inside. */
export function pointInRing(p: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export type ShapeProblem =
  | { code: "not_polygon"; message: string }
  | { code: "bad_coordinates"; message: string }
  | { code: "too_few_points"; message: string }
  | { code: "not_closed"; message: string }
  | { code: "self_intersection"; message: string }
  | { code: "hole_outside"; message: string }
  | { code: "zero_area"; message: string };

/**
 * Check a field shape. Returns null when it is fine, otherwise the first problem in plain
 * words. A bowtie (a ring that crosses itself) is rejected, as the backend would.
 */
export function checkGeometry(g: unknown): ShapeProblem | null {
  const geom = g as { type?: unknown; coordinates?: unknown };
  if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon") || !Array.isArray(geom.coordinates)) {
    return { code: "not_polygon", message: "A field must be a polygon or a set of polygons." };
  }
  const polys = (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates) as unknown[];
  if (polys.length === 0) return { code: "not_polygon", message: "A field must have at least one polygon." };
  for (const poly of polys) {
    if (!Array.isArray(poly) || poly.length === 0) return { code: "not_polygon", message: "A polygon has no outline." };
    for (const ring of poly as unknown[]) {
      if (!Array.isArray(ring) || !ring.every(isPos)) return { code: "bad_coordinates", message: "A point is not a valid longitude and latitude." };
      if (ring.length < 4) return { code: "too_few_points", message: "An outline needs at least three corners." };
      const a = ring[0] as Position, b = ring[ring.length - 1] as Position;
      if (a[0] !== b[0] || a[1] !== b[1]) return { code: "not_closed", message: "An outline does not end where it starts." };
    }
  }
  const field = geom as FieldGeometry;
  if (kinks({ type: "Feature", properties: {}, geometry: field }).features.length > 0) {
    return { code: "self_intersection", message: "The outline crosses itself. Redraw it so the edges do not cross." };
  }
  for (const poly of parcels(field)) {
    const outer = poly[0] as Ring;
    for (const hole of poly.slice(1) as Ring[]) {
      if (!hole.every((p) => pointInRing(p, outer))) return { code: "hole_outside", message: "A cut-out area must sit inside its field." };
    }
  }
  if (areaM2(field) <= 0) return { code: "zero_area", message: "The field has no area." };
  return null;
}

/** Add a cut-out ring to whichever parcel contains it, or say why it cannot be added. */
export function addHole(g: FieldGeometry, ring: Ring): { ok: true; geometry: FieldGeometry } | { ok: false; message: string } {
  const closed = closeRing(ring);
  const polys = parcels(g).map((p) => p.map((r) => r.slice()));
  const idx = polys.findIndex((p) => closed.every((pt) => pointInRing(pt, p[0] as Ring)));
  if (idx < 0) return { ok: false, message: "Draw the cut-out area fully inside the selected field." };
  polys[idx] = [...polys[idx]!, closed];
  const next = fromParcels(polys);
  const problem = checkGeometry(next);
  return problem ? { ok: false, message: problem.message } : { ok: true, geometry: next };
}

/** Add another parcel to a field (a field can be several separate pieces). */
export function addParcel(g: FieldGeometry, ring: Ring): { ok: true; geometry: FieldGeometry } | { ok: false; message: string } {
  const next = fromParcels([...parcels(g), [closeRing(ring)]]);
  const problem = checkGeometry(next);
  return problem ? { ok: false, message: problem.message } : { ok: true, geometry: next };
}
