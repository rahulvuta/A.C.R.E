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

  it("shows the empty state wording with Add Field first and Explore Demo Farm second, and loads nothing by itself", () => {
    render(<Dashboard />);
    expect(screen.getByRole("heading", { name: "No fields available" })).toBeInTheDocument();
    expect(screen.getByText("Add a field to begin managing your farm, planning crop rotations, and analyzing agricultural conditions.")).toBeInTheDocument();
    const empty = screen.getByRole("region", { name: "No fields" });
    const buttons = within(empty).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Add Field", "Explore Demo Farm"]);
    expect(screen.queryByRole("list", { name: "Demo fields" })).toBeNull();
    expect(screen.queryByText(/log ?in|sign ?(in|up)|password/i)).toBeNull();
  });

  it("a field card shows name, acreage, coordinates when no place is known, crop status and an Open button", () => {
    const mine = farmActions.createFarm("My farm", { latitude: 40, longitude: 1 });
    farmActions.addField(mine.farm_id, square(1), "East");
    render(<Dashboard />);
    const card = within(screen.getByRole("list", { name: "Your fields" })).getByRole("listitem");
    expect(within(card).getByRole("heading", { name: "East" })).toBeInTheDocument();
    expect(within(card).getByText("Acreage")).toBeInTheDocument();
    expect(card.textContent).toMatch(/Location\s*(Looking up…|40\.00\d, 1\.00\d)/);
    expect(within(card).getByText("Needs a rotation")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Open East" })).toBeInTheDocument();
  });
});

it("keeps rotation edits on the field and returns Done to its overview", async () => {
  window.scrollTo = () => {};
  const farm = farmActions.createFarm("My farm", { latitude: 40, longitude: 1 });
  const field = farmActions.addField(farm.farm_id, square(1), "Rotation test");
  const { updateSimField, resetSimFieldsForTests } = await import("../../state/simField");
  const { fireEvent } = await import("@testing-library/react");
  resetSimFieldsForTests();
  updateSimField(field.field_id, { rotation: [{ plan_id: "synthetic", previous_crop_id: "field_corn", prev_harvest: "09-20", winter: { kind: "none" }, next_crop_id: "soybean", next_plant: "05-10" }] });
  render(<Dashboard />);
  fireEvent.click(screen.getByRole("button", { name: "Open Rotation test" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit crop rotation" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Next planting" }), { target: { value: "05-11" } });
  fireEvent.click(screen.getByRole("button", { name: "Done, back to field" }));
  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  expect(window.location.hash).toBe(`#d=f/${field.field_id}/overview`);
  expect(screen.queryByRole("heading", { name: "Where is your field?" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit crop rotation" }));
  expect(screen.getByRole("textbox", { name: "Next planting" })).toHaveValue("05-11");
});
