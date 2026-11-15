import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFarmStore } from "../../farm/store";
import { farmActions, resetFarmStoreForTests } from "../../farm/hooks";
import type { FieldGeometry } from "../../farm/types";
import { Dashboard } from "./Dashboard";

const square = (lng: number): FieldGeometry => ({ type: "Polygon", coordinates: [[[lng, 40], [lng + 0.003, 40], [lng + 0.003, 40.003], [lng, 40.003], [lng, 40]]] });
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("dashboard", () => {
  beforeEach(() => { window.history.replaceState(null, "", "/"); resetFarmStoreForTests(createFarmStore(mem())); });
  afterEach(() => { cleanup(); resetFarmStoreForTests(); });

  it("lists each saved field as its own card, apart from demo farms", () => {
    const mine = farmActions.createFarm("My farm", { latitude: 40, longitude: 1 });
    farmActions.addField(mine.farm_id, square(1), "East");
    farmActions.addField(mine.farm_id, square(2), "West");
    const demo = farmActions.createFarm("Demo", { latitude: 40, longitude: 5 });
    farmActions.addField(demo.farm_id, square(5), "Sample");
    farmActions.addFarm({ ...farmActions.createFarm("x", { latitude: 0, longitude: 0 }), farm_id: "d1", demo: "Demo farm", fields: [] });
    render(<Dashboard />);
    const mineList = screen.getByRole("list", { name: "Your fields" });
    expect(within(mineList).getAllByRole("listitem")).toHaveLength(3); // East, West and the un-flagged "Sample"
    expect(screen.queryByRole("heading", { name: "No fields available" })).toBeNull();
  });

  it("a demo-only workspace still shows the empty fields state and keeps the demo separate", () => {
    const demo = farmActions.createFarm("Demo", { latitude: 40, longitude: 5 });
    farmActions.addField(demo.farm_id, square(5), "Sample");
    farmActions.deleteFarm(demo.farm_id);
    farmActions.addFarm({ ...demo, demo: "Demo farm (example values)", fields: [{ field_id: "fld_d", name: "Sample", geometry: square(5), plan: null }] });
    render(<Dashboard />);
    expect(screen.getByRole("heading", { name: "No fields available" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Demo fields" })).getAllByRole("listitem")).toHaveLength(1);
  });
});
