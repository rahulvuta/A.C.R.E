import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildFarms, HALF, sizeAt, SWITCH_SECONDS } from "./spinFarms";

describe("the turning farms on the start page", () => {
  it("builds six different farms, each standing on the slab and inside it", () => {
    const { farms, dispose } = buildFarms();
    expect(farms).toHaveLength(6);
    for (const farm of farms) {
      farm.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(farm);
      // A palm leaf or a roof edge may reach a little past the slab; nothing strays further.
      expect(Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z)).toBeLessThan(HALF + 0.3);
      expect(box.min.y).toBeCloseTo(-0.74, 2);
      expect(box.max.y).toBeGreaterThan(1);
      expect(box.max.y).toBeLessThan(4);
    }
    // No two farms are the same picture.
    expect(new Set(farms.map((f) => f.children.length)).size).toBeGreaterThan(3);
    dispose();
  });

  it("shows each farm for four and a half seconds: it grows in, stands at full size, then shrinks away", () => {
    const T = SWITCH_SECONDS;
    expect(T).toBe(4.5);
    expect(sizeAt(0)).toBeLessThan(0.01);
    expect(sizeAt(0.45)).toBeCloseTo(1, 5);
    for (const u of [0.5, 1, 2, 3, 4, T - 0.26]) expect(sizeAt(u)).toBe(1);
    expect(sizeAt(T - 0.1)).toBeLessThan(1);
    expect(sizeAt(T - 0.1)).toBeGreaterThan(sizeAt(T - 0.01));
    expect(sizeAt(T)).toBeLessThan(0.01);
    // Never bigger than a small bounce past full size, never zero (a zero size breaks the shadows).
    for (let u = 0; u <= T; u += 0.01) {
      expect(sizeAt(u)).toBeGreaterThan(0);
      expect(sizeAt(u)).toBeLessThan(1.06);
    }
  });
});
