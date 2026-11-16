import { describe, expect, it } from "vitest";
import { areaM2, bbox, checkGeometry, squareAround } from "./geometry";
import { exportFarm, importFarm } from "./geojson";
import { createFarmStore, ops, STORAGE_KEY } from "./store";

describe("a field added by typing its size (card 17)", () => {
  it("makes a valid square of the typed size around the pin, anywhere on Earth", () => {
    for (const point of [{ latitude: 1.02, longitude: 35.0 }, { latitude: 52.37, longitude: 9.73 }, { latitude: -33.9, longitude: -60.57 }]) {
      const g = squareAround(point, 20_000); // 2 hectares
      expect(checkGeometry(g)).toBeNull();
      expect(areaM2(g)).toBeGreaterThan(19_900);
      expect(areaM2(g)).toBeLessThan(20_100);
      const [w, s, e, n] = bbox(g);
      expect((w + e) / 2).toBeCloseTo(point.longitude, 6);
      expect((s + n) / 2).toBeCloseTo(point.latitude, 6);
    }
  });

  it("is marked as an approximate shape until the grower traces the real edge, and the mark survives a saved copy", () => {
    const start = ops.createFarm({ schema: "acre.farms.v1", farms: [], selected_farm_id: null, selected_field_id: null } as never, "My farm", { latitude: 1, longitude: 35 });
    const added = ops.addField(start.store, start.farm.farm_id, squareAround({ latitude: 1, longitude: 35 }, 8_000), undefined, true);
    expect(added.field.approx_shape).toBe(true);
    const farm = added.store.farms[0]!;
    const back = importFarm(JSON.stringify(exportFarm(farm)), "Copy");
    expect(back.ok && back.farm.fields[0]!.approx_shape).toBe(true);
    // Editing the shape makes it the grower's own outline.
    const edited = ops.updateField(added.store, added.field.field_id, { geometry: squareAround({ latitude: 1, longitude: 35 }, 9_000) });
    expect(edited.farms[0]!.fields[0]!.approx_shape).toBeUndefined();
    // A drawn field never carries the mark.
    expect(ops.addField(start.store, start.farm.farm_id, squareAround({ latitude: 1, longitude: 35 }, 8_000)).field.approx_shape).toBeUndefined();
  });

  it("keeps the mark when the page is opened again", () => {
    // Found by hand: the mark showed after adding the field and was gone after a reload.
    const start = ops.createFarm({ schema: "acre.farms.v1", farms: [], selected_farm_id: null, selected_field_id: null } as never, "My farm", { latitude: 9.1, longitude: 37.05 });
    const added = ops.addField(start.store, start.farm.farm_id, squareAround({ latitude: 9.1, longitude: 37.05 }, 15_000), undefined, true);
    const kept = new Map<string, string>([[STORAGE_KEY, JSON.stringify(added.store)]]);
    const reopened = createFarmStore({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) });
    expect(reopened.get().farms[0]!.fields[0]!.approx_shape).toBe(true);
  });
});
