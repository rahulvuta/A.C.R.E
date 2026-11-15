import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ROTATION_LEGS } from "../../api/limits";
import { toBackendSimulate } from "../../api/adapt";
import { createGlobalClient } from "../../api/client";
import { FIXTURE_API_BASE, fixtureFetch } from "../../api/fixtures";
import { geoApiFrom } from "../../api/geoApi";
import { resetFarmStoreForTests } from "../../farm/hooks";
import { getSimField, resetSimFieldsForTests } from "../../state/simField";
import { clearSimulationsForTests } from "../../state/useSimulation";
import type { GlobalApi } from "../../state/useGlobal";
import { rotationReady, simulateRequest } from "./context";
import { Guided } from "./Guided";
import { emptySeason, planInputKey } from "./StepNow";

vi.mock("../../map/FarmMap", () => ({ FarmMap: () => <div aria-label="Farm map" /> }));

const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 2000, fetchImpl: fixtureFetch() });
const api: GlobalApi = { client, geo: geoApiFrom(client), source: "fixtures" };
const plan = { plan_id: "p", previous_crop_id: "field_corn", prev_harvest: "09-20", winter: { kind: "none" as const }, next_crop_id: "soybean", next_plant: "05-10" };

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

describe("rotation length limit", () => {
  it("matches the backend's MAX_ROTATION_LEGS (10)", () => { expect(MAX_ROTATION_LEGS).toBe(10); });

  it("accepts up to 10 legs in a simulate request and refuses 11", () => {
    const rot = (n: number) => Array.from({ length: n }, (_, i) => ({ ...plan, plan_id: `season_${i + 1}` }));
    expect(rotationReady(rot(10))).toBe(true);
    expect(rotationReady(rot(11))).toBe(false);
    const field = { field_id: "f", name: "F", geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] }, plan: null };
    const point = { latitude: 0, longitude: 0 };
    const q = simulateRequest({ field, sim: { ...getSimField("f"), rotation: rot(10) }, point }, [])!;
    expect(toBackendSimulate(q).scenarios[0]!.rotation).toHaveLength(10);
    expect(simulateRequest({ field, sim: { ...getSimField("f"), rotation: rot(11) }, point }, [])).toBeNull();
  });

  it("gives every new season a unique plan id, also after a middle season was removed", () => {
    expect(emptySeason(2, "", ["season_1", "season_3"]).plan_id).toBe("season_4");
    expect(emptySeason(2, "", ["season_1", "season_2"]).plan_id).toBe("season_3");
  });

  it("keeps saved dates of the current plan and of an alternative apart", () => {
    expect(planInputKey("rot", "season_1")).toBe("season_1");
    expect(planInputKey("s_abc", "season_1")).not.toBe(planInputKey("rot", "season_1"));
  });

  it("lets the grower add seasons up to 10 and remove them again", async () => {
    render(<Guided api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /Union County, North Carolina/ }));
    await screen.findByRole("heading", { name: "What do you grow on this field now?" });
    const count = () => document.querySelectorAll(".gf-season").length;
    for (let guard = 0; guard < 12 && screen.queryByRole("button", { name: "Add a season" }); guard++) fireEvent.click(screen.getByRole("button", { name: "Add a season" }));
    expect(count()).toBe(10);
    expect(screen.queryByRole("button", { name: "Add a season" })).toBeNull();
    const fieldId = Object.keys(JSON.parse(window.localStorage.getItem("acre.simfield.v1")!).fields)[0]!;
    const ids = getSimField(fieldId).rotation.map((p) => p.plan_id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove season" })[4]!);
    expect(count()).toBe(9);
    fireEvent.click(screen.getByRole("button", { name: "Add a season" }));
    const after = getSimField(fieldId).rotation.map((p) => p.plan_id);
    expect(after).toHaveLength(10);
    expect(new Set(after).size).toBe(10);
  });
});
