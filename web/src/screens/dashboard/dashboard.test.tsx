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
    // with fields, the big button adds another one
    expect(screen.getByRole("button", { name: "Add a field" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create your farm" })).toBeNull();
  });

  it("with only an example farm loaded, the start is still one button, and the example stays apart", () => {
    const demo = farmActions.createFarm("Demo", { latitude: 40, longitude: 5 });
    farmActions.addField(demo.farm_id, square(5), "Sample");
    farmActions.deleteFarm(demo.farm_id);
    farmActions.addFarm({ ...demo, demo: "Demo farm (example values)", fields: [{ field_id: "fld_d", name: "Sample", geometry: square(5), plan: null }] });
    render(<Dashboard />);
    expect(screen.getByRole("button", { name: "Create your farm" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your fields" })).toBeNull();
    // the example's field is under "Example farms", never among the grower's own
    expect(within(screen.getByRole("group", { name: "Example farms", hidden: true })).getAllByRole("listitem", { hidden: true })).toHaveLength(1);
  });

  it("starts with one big button and nothing else to choose: no sidebar, no second call to action, nothing loaded", () => {
    render(<Dashboard />);
    const start = screen.getByRole("region", { name: "Create your farm" });
    expect(within(start).getAllByRole("button").map((b) => b.textContent)).toEqual(["Create your farm"]);
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull(); // the sidebar starts once a field is open
    expect(screen.queryByRole("heading", { name: "No fields available" })).toBeNull();
    // example farms are folded away, and none is loaded until asked for
    expect(screen.getByText("Example farms").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByRole("list", { name: "Demo fields", hidden: true })).toBeNull();
    expect(screen.queryByText(/log ?in|sign ?(in|up)|password/i)).toBeNull();
  });

  it("a field card shows name, acreage, coordinates when no place is known, crop status and an Open button", () => {
    const mine = farmActions.createFarm("My farm", { latitude: 40, longitude: 1 });
    farmActions.addField(mine.farm_id, square(1), "East");
    render(<Dashboard />);
    const card = within(screen.getByRole("list", { name: "Your fields" })).getByRole("listitem");
    expect(within(card).getByRole("heading", { name: "East" })).toBeInTheDocument();
    // three lines, no table of labels: the size, then the place (or the point until the place is known)
    expect(card.querySelector(".dash-meta")!.textContent).toMatch(/(ha|ac).*(Looking up…|40\.00\d, 1\.00\d)/);
    expect(within(card).queryByText("Size")).toBeNull();
    // how far along it is: a six-step bar that says so to a screen reader, with no "not set" line
    expect(within(card).getByRole("img", { name: "Step 2 of 6. Needs a rotation." })).toBeInTheDocument();
    expect(within(card).queryByText("Not set")).toBeNull();
    expect(within(card).getByRole("button", { name: "Open East" })).toBeInTheDocument();
  });

  it("a field card carries on the guided sequence from the field's next step", () => {
    const mine = farmActions.createFarm("My farm", { latitude: 40, longitude: 1 });
    farmActions.addField(mine.farm_id, square(1), "East");
    render(<Dashboard />);
    const card = within(screen.getByRole("list", { name: "Your fields" })).getByRole("listitem");
    const bar = within(card).getByRole("img", { name: /^Step 2 of 6/ });
    expect(bar.querySelectorAll('i[data-on="done"]')).toHaveLength(1);
    expect(bar.querySelectorAll('i[data-on="now"]')).toHaveLength(1);
    expect(within(card).getByRole("link", { name: "Continue East: What you do now" })).toHaveAttribute("href", "?view=app#u=now");
  });
});

it("a field page is one summary: outline, plan in one line, the six steps, and a way back into each", async () => {
  window.scrollTo = () => {};
  const farm = farmActions.createFarm("My farm", { latitude: 40, longitude: 1 });
  const field = farmActions.addField(farm.farm_id, square(1), "Rotation test");
  const { updateSimField, resetSimFieldsForTests } = await import("../../state/simField");
  const { fireEvent } = await import("@testing-library/react");
  resetSimFieldsForTests();
  updateSimField(field.field_id, { rotation: [{ plan_id: "synthetic", previous_crop_id: "field_corn", prev_harvest: "09-20", winter: { kind: "none" }, next_crop_id: "soybean", next_plant: "05-10" }] });
  render(<Dashboard />);
  fireEvent.click(screen.getByRole("button", { name: "Open Rotation test" }));
  expect(window.location.hash).toBe(`#d=f/${field.field_id}/overview`);
  // No tabs: the steps own every screen.
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.getByRole("img", { name: "Outline of Rotation test" })).toBeInTheDocument();
  const details = screen.getByRole("region", { name: "Field details" });
  expect(details.textContent).toMatch(/What you grow: .*corn.*→.*Soybean/i);
  expect(within(details).getByRole("link", { name: "Change crops and dates" })).toHaveAttribute("href", "?view=app#u=now&p=crops");
  const steps = screen.getByRole("region", { name: "Where you are in the six steps" });
  expect(within(steps).getAllByRole("listitem")).toHaveLength(6);
  expect(within(steps).getByRole("link", { name: /^Continue: / })).toHaveAttribute("href", expect.stringMatching(/^\?view=app#u=/));
  expect(screen.getByRole("region", { name: "Readings and local conditions" })).toBeInTheDocument();
});
