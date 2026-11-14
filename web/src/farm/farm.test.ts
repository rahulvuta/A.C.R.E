import { describe, expect, it } from "vitest";
import polygonsFixture from "../api/fixtures/polygons.json";
import { addHole, addParcel, areaAc, areaHa, checkGeometry, formatArea } from "./geometry";
import { exportFarm, importFarm } from "./geojson";
import { BACKUP_KEY, STORAGE_KEY, createFarmStore, migrate, ops, type StorageLike } from "./store";
import type { FieldGeometry } from "./types";

type Poly = { geometry: FieldGeometry; area_ha: number | null; valid: boolean };
const P = polygonsFixture.polygons as unknown as Record<string, Poly>;

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe("geometry", () => {
  it("each contract fixture polygon's area is within 0.1% of its area_ha", () => {
    for (const [name, p] of Object.entries(P)) {
      if (!p.valid) continue;
      const ha = areaHa(p.geometry);
      expect(Math.abs(ha - p.area_ha!) / p.area_ha!, name).toBeLessThan(0.001);
    }
  });

  it("a bowtie is rejected with a plain message", () => {
    const problem = checkGeometry(P.bowtie!.geometry);
    expect(problem?.code).toBe("self_intersection");
    expect(problem?.message).toMatch(/crosses itself/);
  });

  it("acres and hectares agree", () => {
    const g = P.pergamino_square!.geometry;
    expect(areaAc(g) / areaHa(g)).toBeCloseTo(2.4710538, 5);
    expect(formatArea(g)).toEqual({ ha: "103 ha", ac: "254 ac" });
  });

  it("rejects open rings, bad numbers and holes outside the field", () => {
    expect(checkGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })?.code).toBe("not_closed");
    expect(checkGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] })?.code).toBe("too_few_points");
    expect(checkGeometry({ type: "Polygon", coordinates: [[[0, 0], [200, 0], [1, 1], [0, 0]]] })?.code).toBe("bad_coordinates");
    expect(checkGeometry({ type: "Point", coordinates: [0, 0] })?.code).toBe("not_polygon");
    const outer = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const away = [[2, 2], [3, 2], [3, 3], [2, 2]];
    expect(checkGeometry({ type: "Polygon", coordinates: [outer, away] })?.code).toBe("hole_outside");
  });

  it("adds a hole inside the right parcel, and refuses one outside", () => {
    const g = P.union_parcels!.geometry;
    const before = areaHa(g);
    const hole: [number, number][] = [[-80.548, 34.982], [-80.546, 34.982], [-80.546, 34.980], [-80.548, 34.980]];
    const r = addHole(g, hole);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.geometry.type).toBe("MultiPolygon");
    expect((r.geometry.coordinates as number[][][][])[1]).toHaveLength(2);
    expect(areaHa(r.geometry)).toBeLessThan(before);
    expect(addHole(g, [[-80.0, 34.0], [-79.9, 34.0], [-79.9, 34.1]]).ok).toBe(false);
  });

  it("adding a parcel turns a polygon into a multipolygon", () => {
    const r = addParcel(P.pergamino_square!.geometry, [[-60.56, -33.88], [-60.555, -33.88], [-60.555, -33.885]]);
    expect(r.ok && r.geometry.type).toBe("MultiPolygon");
  });
});

describe("store", () => {
  const anchor = { latitude: -33.89, longitude: -60.57 };

  it("persists two fields, a rename and a hole across a reload", () => {
    const storage = new MemStorage();
    const h = createFarmStore(storage);
    let s = ops.createFarm(h.get(), "Home farm", anchor).store;
    const farmId = s.selected_farm_id!;
    const a = ops.addField(s, farmId, P.pergamino_square!.geometry);
    s = a.store;
    const b = ops.addField(s, farmId, P.pergamino_l!.geometry);
    s = ops.updateField(b.store, a.field.field_id, { name: "North 40" });
    const hole = addHole(P.pergamino_square!.geometry, [[-60.578, -33.882], [-60.575, -33.882], [-60.575, -33.885]]);
    expect(hole.ok).toBe(true);
    s = ops.updateField(s, b.field.field_id, { name: "L field" });
    s = ops.updateField(s, a.field.field_id, { geometry: (hole as { geometry: FieldGeometry }).geometry });
    h.set(s);

    const reloaded = createFarmStore(storage).get();
    const farm = reloaded.farms[0]!;
    expect(farm.fields.map((f) => f.name)).toEqual(["North 40", "L field"]);
    expect((farm.fields[0]!.geometry.coordinates as number[][][]).length).toBe(2);
    expect(farm.fields[0]!.display_area_ha!).toBeLessThan(P.pergamino_square!.area_ha!);
    expect(reloaded.selected_farm_id).toBe(farmId);
  });

  it("refuses an invalid shape instead of saving it", () => {
    const s = ops.createFarm(createFarmStore(null).get(), "x", anchor).store;
    expect(() => ops.addField(s, s.selected_farm_id!, P.bowtie!.geometry)).toThrow(/crosses itself/);
  });

  it("falls back to memory when storage throws, and says so", () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const h = createFarmStore(broken);
    expect(h.persistence()).toBe("local");
    h.set(ops.createFarm(h.get(), "x", anchor).store);
    expect(h.persistence()).toBe("memory");
    expect(h.notice()).toMatch(/Export them as GeoJSON/);
    expect(h.get().farms).toHaveLength(1);
  });

  it("keeps an unreadable store as a backup instead of overwriting it silently", () => {
    const storage = new MemStorage();
    storage.setItem(STORAGE_KEY, "{not json");
    const h = createFarmStore(storage);
    expect(h.get().farms).toEqual([]);
    expect(storage.getItem(BACKUP_KEY)).toBe("{not json");
    expect(h.notice()).toMatch(/could not be read/);
  });

  it("migration drops bad fields and keeps good ones", () => {
    const m = migrate({
      schema: "acre.farms.v1",
      farms: [{ farm_id: "farm_1", name: "A", fields: [{ field_id: "f1", name: "ok", geometry: P.pergamino_square!.geometry, plan: null }, { field_id: "f2", geometry: P.bowtie!.geometry }] }],
      selected_farm_id: "farm_1",
      selected_field_id: "f2",
    });
    expect(m!.dropped).toBe(1);
    expect(m!.store.farms[0]!.fields.map((f) => f.field_id)).toEqual(["f1"]);
    expect(m!.store.selected_field_id).toBeNull();
    expect(migrate({ schema: "other" })).toBeNull();
  });

  it("selecting a field selects its farm", () => {
    let s = ops.createFarm(createFarmStore(null).get(), "A", anchor).store;
    const a = ops.addField(s, s.selected_farm_id!, P.pergamino_square!.geometry);
    s = ops.createFarm(a.store, "B", anchor).store;
    s = ops.selectField(s, a.field.field_id);
    expect(s.selected_farm_id).toBe(a.store.selected_farm_id);
    expect(s.selected_field_id).toBe(a.field.field_id);
  });
});

describe("GeoJSON", () => {
  const anchor = { latitude: -33.89, longitude: -60.57 };
  function farmWithFields() {
    let s = ops.createFarm(createFarmStore(null).get(), "Home farm", anchor).store;
    for (const k of ["pergamino_square", "pergamino_holed", "union_parcels"]) s = ops.addField(s, s.selected_farm_id!, P[k]!.geometry).store;
    return s.farms[0]!;
  }

  it("export then import round-trips geometry, names and ids exactly", () => {
    const farm = farmWithFields();
    const text = JSON.stringify(exportFarm(farm));
    const r = importFarm(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.farm.name).toBe("Home farm");
    expect(r.farm.fields.map((f) => f.geometry)).toEqual(farm.fields.map((f) => f.geometry));
    expect(r.farm.fields.map((f) => [f.field_id, f.name, f.plan])).toEqual(farm.fields.map((f) => [f.field_id, f.name, f.plan]));
    expect(r.farm.farm_id).not.toBe(farm.farm_id);
  });

  it("a file with one bad feature is rejected whole, listing the problem", () => {
    const fc = exportFarm(farmWithFields());
    fc.features.push({ type: "Feature", geometry: P.bowtie!.geometry, properties: { field_id: "bad", name: "Bowtie", plan: null } });
    const r = importFarm(JSON.stringify(fc));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems).toEqual(["Feature 4 (Bowtie): The outline crosses itself. Redraw it so the edges do not cross."]);
  });

  it("rejects non-GeoJSON, empty and duplicate-id files", () => {
    expect(importFarm("hello").ok).toBe(false);
    expect(importFarm('{"type":"FeatureCollection","features":[]}').ok).toBe(false);
    const fc = exportFarm(farmWithFields());
    fc.features[1]!.properties.field_id = fc.features[0]!.properties.field_id;
    const r = importFarm(JSON.stringify(fc));
    expect(!r.ok && r.problems[0]).toMatch(/used twice/);
  });

  it("accepts a single bare polygon as a one-field farm", () => {
    const r = importFarm(JSON.stringify(P.pergamino_l!.geometry), "Drawn elsewhere");
    expect(r.ok && r.farm.fields.length).toBe(1);
    expect(r.ok && r.farm.name).toBe("Drawn elsewhere");
  });

  it("re-importing into the same browser gives clashing field ids new ones", () => {
    const farm = farmWithFields();
    let s = ops.addFarm(createFarmStore(null).get(), farm);
    const again = importFarm(JSON.stringify(exportFarm(farm)));
    s = ops.addFarm(s, (again as { farm: typeof farm }).farm);
    const ids = s.farms.flatMap((f) => f.fields.map((x) => x.field_id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
