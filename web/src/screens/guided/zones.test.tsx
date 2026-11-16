import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBackendSimulate } from "../../api/adapt";
import { createGlobalClient } from "../../api/client";
import { FIXTURE_API_BASE, fixtureFetch } from "../../api/fixtures";
import { geoApiFrom } from "../../api/geoApi";
import { resetFarmStoreForTests } from "../../farm/hooks";
import { ZONES_ENABLED, evenShares, getSimField, resetSimFieldsForTests, setZoneLayout } from "../../state/simField";
import { clearSimulationsForTests } from "../../state/useSimulation";
import type { GlobalApi } from "../../state/useGlobal";
import { baselineReady, simulateRequest, zonesOk } from "./context";
import { Guided } from "./Guided";

vi.mock("../../map/FarmMap", () => ({ FarmMap: () => <div aria-label="Farm map" /> }));

const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 2000, fetchImpl: fixtureFetch() });
const api: GlobalApi = { client, geo: geoApiFrom(client), source: "fixtures" };
const corn = { plan_id: "a", previous_crop_id: "soybean", prev_harvest: "10-20", winter: { kind: "none" as const }, next_crop_id: "field_corn", next_plant: "04-25" };
const soy = { plan_id: "b", previous_crop_id: "field_corn", prev_harvest: "09-20", winter: { kind: "none" as const }, next_crop_id: "soybean", next_plant: "05-10" };
const field = { field_id: "f", name: "F", geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] }, plan: null };
const point = { latitude: 0, longitude: 0 };

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    get length() { return values.size; }, clear: () => values.clear(), getItem: (k: string) => values.get(k) ?? null,
    key: (i: number) => [...values.keys()][i] ?? null, removeItem: (k: string) => values.delete(k), setItem: (k: string, v: string) => values.set(k, String(v)),
  } satisfies Storage });
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/?view=app");
  resetFarmStoreForTests(); resetSimFieldsForTests(); clearSimulationsForTests();
});

// Zones are switched off for now (ZONES_ENABLED); these run again when they come back.
describe.skipIf(!ZONES_ENABLED)("field zones", () => {
  it("makes equal shares that add up to exactly 1", () => {
    for (const n of [2, 3, 7]) expect(evenShares(n).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("sends each zone's own rotation for the baseline and one rotation for alternatives", () => {
    setZoneLayout("f", [{ zoneId: "n", name: "North", share: 0.4 }, { zoneId: "s", name: "South", share: 0.6 }], { n: [corn], s: [soy] });
    const sim = getSimField("f");
    expect(sim.rotation[0]!.plan_id).toBe("b"); // the largest zone stands in for the field's plan
    expect(zonesOk(sim.zones)).toBe(true);
    expect(baselineReady(sim)).toBe(true);
    const alt = { scenarioId: "alt", label: "All corn", isBaseline: false, rotation: [corn], from: "custom" as const };
    const q = simulateRequest({ field, sim, point }, [alt])!;
    const body = toBackendSimulate(q);
    expect(body.field.zones).toEqual([{ zone_id: "n", name: "North", share: 0.4 }, { zone_id: "s", name: "South", share: 0.6 }]);
    expect(body.scenarios[0]!.rotation).toBeUndefined();
    expect(Object.keys(body.scenarios[0]!.zone_rotations!)).toEqual(["n", "s"]);
    expect(body.scenarios[1]!.rotation).toHaveLength(1);
    expect(body.scenarios[1]!.zone_rotations).toBeUndefined();
  });

  it("is not ready while shares do not add up or a zone is incomplete", () => {
    setZoneLayout("f", [{ zoneId: "n", name: "North", share: 0.4 }, { zoneId: "s", name: "South", share: 0.4 }], { n: [corn], s: [soy] });
    expect(baselineReady(getSimField("f"))).toBe(false);
    setZoneLayout("f", [{ zoneId: "n", name: "North", share: 0.5 }, { zoneId: "s", name: "South", share: 0.5 }], { n: [corn], s: [] });
    expect(baselineReady(getSimField("f"))).toBe(false);
  });

  it("leaves a field with fewer than two zones as one plan", () => {
    setZoneLayout("f", [{ zoneId: "n", name: "North", share: 1 }], { n: [corn] });
    const sim = getSimField("f");
    expect(sim.zones).toEqual([]);
    expect(sim.rotation[0]!.plan_id).toBe("a");
    expect(toBackendSimulate(simulateRequest({ field, sim, point }, [])!).field.zones).toBeUndefined();
  });

  it("lets the grower split a field into zones and go back", async () => {
    render(<Guided api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /Union County, North Carolina/ }));
    await screen.findByRole("heading", { name: "What do you grow on this field now?" });
    fireEvent.click(screen.getByRole("button", { name: "Split this field into zones" }));
    expect(screen.getAllByLabelText(/^Zone Zone/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Add a zone" }));
    expect(screen.getAllByLabelText(/^Zone Zone/)).toHaveLength(3);
    expect(screen.getByText("Shares add up to 100%")).toBeTruthy();
    const fieldId = Object.keys(JSON.parse(window.localStorage.getItem("acre.simfield.v1")!).fields)[0]!;
    expect(getSimField(fieldId).zones).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Back to one plan for the whole field" }));
    expect(getSimField(fieldId).zones).toEqual([]);
    expect(screen.getByRole("button", { name: "Split this field into zones" })).toBeTruthy();
  });
});
