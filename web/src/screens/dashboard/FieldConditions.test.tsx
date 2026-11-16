import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalClient } from "../../api/client";
import { geoApiFrom } from "../../api/geoApi";
import type { Field } from "../../farm/types";
import { farmActions, resetFarmStoreForTests } from "../../farm/hooks";
import { createFarmStore } from "../../farm/store";
import { createExampleInputsApi } from "../../inputs/examples";
import type { ConditionsRequest, FieldConditionsResponse } from "../../inputs/conditions";
import { getSimField, resetSimFieldsForTests, updateSimField, useSimField } from "../../state/simField";
import type { GlobalApi } from "../../state/useGlobal";
import { FieldConditions } from "./FieldConditions";

const source = { title: "Synthetic soil fixture", url: "https://example.edu/soil" };
const emptyAssessment = { status: "unavailable", reason_text: "No source-checked range yet.", impacts: [], note: "Synthetic assessment fixture." };
const response = (q: ConditionsRequest): FieldConditionsResponse => {
  const ph = q.readings.filter(r => r.kind === "soil_ph").at(-1);
  return { status: "complete", as_of: "2026-11-15", note: "Synthetic baseline fixture.", assessment: emptyAssessment,
    values: [{ key: "soil_ph", kind: "soil_ph", label: "Soil pH / acidity", value: ph?.value ?? 6.4, unit: "pH",
      origin: ph ? "grower" : "dataset_estimate", date: ph?.date ?? null, depth_cm: null, moisture_basis: null,
      note: "Synthetic fixture.", baseline: { value: 6.4, origin: "dataset_estimate", source, note: "Synthetic local baseline." } }] };
};
let field: Field;

beforeEach(() => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  resetFarmStoreForTests(createFarmStore(storage)); resetSimFieldsForTests();
  const farm = farmActions.createFarm("Synthetic test farm", { latitude: 34.98, longitude: -80.55 });
  field = farmActions.addField(farm.farm_id, { type: "Polygon", coordinates: [[[-80.55, 34.98], [-80.54, 34.98], [-80.54, 34.99], [-80.55, 34.98]]] }, "Synthetic field");
  updateSimField(field.field_id, { rotation: [{ plan_id: "synthetic", previous_crop_id: "soybean", next_crop_id: "soybean", prev_harvest: "10-01", next_plant: "05-01", winter: { kind: "none" } }] });
});

function setup() {
  const conditions = vi.fn(async (q: ConditionsRequest) => response(q));
  const assessConditions = vi.fn(async () => ({ assessment: { ...emptyAssessment, status: "complete", reason_text: null,
    impacts: [{ key: "soil_ph", crop_id: "soybean", rating: "abnormal" as const, effect: "Synthetic acidity impact.", normal_min: 6, normal_max: 6.5, unit: "pH", context: "Synthetic crop interval.", origin: "source_checked", source }] } }));
  const base = createGlobalClient({ apiBase: null, timeoutMs: 2000 });
  const client = { ...base, inputs: { ...createExampleInputsApi(), conditions, assessConditions } };
  const api: GlobalApi = { client, geo: geoApiFrom(client), source: "fixtures" };
  function Screen() {
    const sim = useSimField(field.field_id);
    return <FieldConditions ctx={{ api, field, farm: null, sim, point: { latitude: 34.98, longitude: -80.55 }, regionKey: "US-NC", profile: null, go: vi.fn() }} />;
  }
  render(<Screen />);
  return { conditions, assessConditions };
}

describe("field conditions", () => {
  it("shows regional estimates beside personal inputs, saves pH and restores the baseline", async () => {
    const { conditions, assessConditions } = setup();
    expect(screen.getByLabelText("Regional conditions")).toBeInTheDocument();
    expect(screen.getByLabelText("Personal field conditions")).toBeInTheDocument();
    await screen.findByRole("link", { name: "Synthetic soil fixture" });
    const log = screen.getByRole("region", { name: "Field readings" });
    fireEvent.click(within(log).getByRole("button", { name: "Soil test pH" }));
    fireEvent.change(within(log).getByRole("spinbutton", { name: "Soil pH / acidity (pH)" }), { target: { value: "4.2" } });
    fireEvent.click(within(log).getByRole("button", { name: "Add reading" }));
    await screen.findByText("Outside normal range");
    expect(getSimField(field.field_id).readings.at(-1)?.value).toBe(4.2);
    expect(conditions.mock.lastCall?.[0].readings[0]).toMatchObject({ kind: "soil_ph", value: 4.2 });
    expect(assessConditions).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Synthetic acidity impact.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use baseline for Soil pH / acidity" }));
    await waitFor(() => expect(conditions.mock.lastCall?.[0].readings).toEqual([]));
    expect(getSimField(field.field_id).readings).toEqual([]);
    expect(screen.queryByText("Outside normal range")).not.toBeInTheDocument();
    expect(assessConditions).toHaveBeenCalledTimes(1);
  });

  it("keeps a blank value missing and records custom condition names, units and zero", async () => {
    const { conditions } = setup();
    const log = screen.getByRole("region", { name: "Field readings" });
    fireEvent.click(within(log).getByRole("button", { name: "Add reading" }));
    expect(within(log).getByRole("alert")).toHaveTextContent("Enter a reading");
    expect(getSimField(field.field_id).readings).toEqual([]);
    fireEvent.change(within(log).getByRole("combobox", { name: "Reading type" }), { target: { value: "custom" } });
    fireEvent.change(within(log).getByLabelText("Condition name"), { target: { value: "Synthetic phosphorus" } });
    fireEvent.change(within(log).getByLabelText("Measurement unit"), { target: { value: "mg/kg" } });
    fireEvent.change(within(log).getByRole("spinbutton", { name: "Other condition ()" }), { target: { value: "0" } });
    fireEvent.click(within(log).getByRole("button", { name: "Add reading" }));
    await waitFor(() => expect(conditions.mock.lastCall?.[0].readings[0]).toMatchObject({ kind: "custom", value: 0, name: "Synthetic phosphorus", unit: "mg/kg" }));
    expect(getSimField(field.field_id).readings[0]).toMatchObject({ name: "Synthetic phosphorus", unit: "mg/kg", value: 0 });
  });

  it("preserves the moisture measurement method through saving and the API request", async () => {
    const { conditions } = setup();
    const log = screen.getByRole("region", { name: "Field readings" });
    fireEvent.change(within(log).getByRole("combobox", { name: "Reading type" }), { target: { value: "soil_moisture_pct" } });
    fireEvent.change(within(log).getByRole("combobox", { name: "Moisture measurement method" }), { target: { value: "saturation" } });
    fireEvent.change(within(log).getByRole("spinbutton", { name: "Soil moisture (%)" }), { target: { value: "35" } });
    fireEvent.click(within(log).getByRole("button", { name: "Add reading" }));
    await waitFor(() => expect(conditions.mock.lastCall?.[0].readings[0]).toMatchObject({ value: 35, moisture_basis: "saturation" }));
    expect(getSimField(field.field_id).readings[0]?.moisture_basis).toBe("saturation");
  });
});
