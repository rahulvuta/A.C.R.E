import { describe, expect, it } from "vitest";
import { toBackendSimulate } from "../../api/adapt";
import { emptySimField } from "../../state/simField";
import { economicsReady, economicsValue, simulationOverrides } from "./inputState";

describe("guided input state", () => {
  it("keeps price cases, zero costs and losses through editor and request adaptation", () => {
    const sim = { ...emptySimField(), overrides: { soybean: { price: { value: 11.2, unit: "USD/bu" }, costPerArea: { value: 0, unit: "USD/acre" } } } };
    const editor = economicsValue(sim);
    expect(editor.overrides.soybean?.price?.low?.value).toBe(11.2);
    editor.overrides.soybean!.price!.low!.value = 9;
    const overrides = simulationOverrides(editor);
    const body = toBackendSimulate({ point: { latitude: 0, longitude: 0 }, field: { fieldId: "f", name: "Synthetic test", areaHa: null, equipment: [], readings: [] }, priorities: {}, overrides, loss: sim.loss, scenarios: [], startSeason: "2027" });
    expect(body.economics.overrides.soybean).toEqual({ price: { low: 9, typical: 11.2, high: 11.2, unit: "USD/bu" }, costs: { total: { value: 0, unit: "USD/acre" } } });
    expect(economicsReady({ ...sim, economicsInputs: editor })).toBe(true);
  });
  it("blocks incomplete or mixed-unit overrides, instead of using hidden defaults", () => {
    const sim = emptySimField();
    const editor = economicsValue(sim);
    editor.overrides.soybean = { price: { low: { value: 0, unit: "USD/bu", origin: "grower" } } };
    expect(economicsReady({ ...sim, economicsInputs: editor })).toBe(false);
    editor.overrides.soybean.price!.typical = { value: 10, unit: "USD/bu", origin: "grower" };
    editor.overrides.soybean.price!.high = { value: 15, unit: "USD/t", origin: "grower" };
    expect(economicsReady({ ...sim, economicsInputs: editor })).toBe(false);
    editor.overrides.soybean.price!.high!.unit = "USD/bu";
    expect(economicsReady({ ...sim, economicsInputs: editor })).toBe(true);
    editor.overrides.soybean.costs = { seed: { value: null, unit: "USD/acre", origin: "grower" } };
    expect(economicsReady({ ...sim, economicsInputs: editor })).toBe(false);
  });
  it("serializes a grower's complete cost list without provenance-only UI fields", () => {
    const value = economicsValue(emptySimField());
    value.overrides.soybean = { costs: { seed: { value: 0, unit: "USD/acre", origin: "grower" }, fuel: { value: 12, unit: "USD/acre", origin: "grower" } } };
    expect(simulationOverrides(value).soybean?.costItems).toEqual([{ item: "seed", value: 0, unit: "USD/acre" }, { item: "fuel", value: 12, unit: "USD/acre" }]);
  });
});
