import { describe, expect, it } from "vitest";
import polygonsFixture from "../api/fixtures/polygons.json";
import type { FieldGeometry } from "../farm/types";
import { insideStage, slabGeometry, stageShape } from "./polygonShape";

type Poly = { geometry: FieldGeometry; area_ha: number | null; valid: boolean };
const P = polygonsFixture.polygons as unknown as Record<string, Poly>;

describe("stageShape (card C3)", () => {
  it("the L-shaped fixture becomes one 6-corner shape that fits the stage", () => {
    const st = stageShape(P.pergamino_l!.geometry, 7.4, 7.4)!;
    expect(st.shapes).toHaveLength(1);
    expect(st.shapes[0]!.getPoints()).toHaveLength(6);
    expect(st.shapes[0]!.holes).toHaveLength(0);
    for (const [x, y] of st.rings[0]![0]!) {
      expect(Math.abs(x)).toBeLessThanOrEqual(3.7);
      expect(Math.abs(y)).toBeLessThanOrEqual(3.7);
    }
    // The notch of the L (south-east) is empty.
    expect(insideStage(st, 2, -3)).toBe(false);
    expect(insideStage(st, -2.5, 3)).toBe(true);
  });

  it("the holed fixture keeps its hole, and the slab has fewer top faces' area there", () => {
    const st = stageShape(P.pergamino_holed!.geometry, 7.4, 7.4)!;
    expect(st.shapes[0]!.holes).toHaveLength(1);
    expect(insideStage(st, 0, 0)).toBe(false); // the hole is in the middle of the fixture
    const solid = slabGeometry(stageShape(P.pergamino_square!.geometry, 7.4, 7.4)!, 0.35);
    const holed = slabGeometry(st, 0.35);
    expect(holed.getAttribute("position").count).toBeGreaterThan(solid.getAttribute("position").count);
    holed.computeBoundingBox();
    expect(holed.boundingBox!.min.y).toBeCloseTo(0, 5);
    expect(holed.boundingBox!.max.y).toBeCloseTo(0.35, 5);
  });

  it("a multipolygon gives one shape per parcel", () => {
    const st = stageShape(P.union_parcels!.geometry, 7.4, 7.4)!;
    expect(st.shapes.length).toBe((P.union_parcels!.geometry.coordinates as unknown[]).length);
  });

  it("no geometry, or a degenerate one, falls back (null)", () => {
    expect(stageShape(null, 7.4, 7.4)).toBeNull();
    expect(stageShape({ type: "Polygon", coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] }, 7.4, 7.4)).toBeNull();
  });
});
