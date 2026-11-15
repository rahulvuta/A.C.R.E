import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalClient } from "../../api/client";
import { FIXTURE_API_BASE, fixtureFetch } from "../../api/fixtures";
import { geoApiFrom } from "../../api/geoApi";
import { resetFarmStoreForTests } from "../../farm/hooks";
import { getSimField, resetSimFieldsForTests } from "../../state/simField";
import { clearSimulationsForTests } from "../../state/useSimulation";
import type { GlobalApi } from "../../state/useGlobal";
import { cropsOf, planReady, simulateRequest } from "./context";
import { Guided } from "./Guided";
import { STEPS } from "./steps";

vi.mock("../../map/FarmMap", () => ({ FarmMap: () => <div aria-label="Farm map" /> }));

const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 2000, fetchImpl: fixtureFetch() });
const api: GlobalApi = { client, geo: geoApiFrom(client), source: "fixtures" };

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, String(value)),
  } satisfies Storage });
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/?view=app");
  resetFarmStoreForTests();
  resetSimFieldsForTests();
  clearSimulationsForTests();
});

describe("guided flow (U1)", () => {
  it("has six steps, each with one question, one sentence and a glossary term", () => {
    expect(STEPS.map((s) => s.nav)).toEqual(["Your farm", "What you do now", "Simulate current plan", "Try other plans", "Compare", "Your 10-year plan"]);
    for (const s of STEPS) {
      expect(s.question).toMatch(/\?$/);
      expect(s.sentence).toMatch(/\.$/);
    }
  });

  it("locks later steps until there is a field and a complete current plan", () => {
    render(<Guided api={api} />);
    const nav = screen.getByRole("navigation", { name: "Steps" });
    expect(within(nav).getByRole("button", { name: /What you do now/ })).toBeDisabled();
    expect(within(nav).getByRole("button", { name: /Compare/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next: What you do now/ })).toBeDisabled();
    expect(screen.getByText(/What does this mean\?/)).toBeInTheDocument();
  });

  it("the Union County demo fills every step: plan, equipment, prices, simulation, comparison, 10-year plan", async () => {
    render(<Guided api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /Union County, North Carolina/ }));
    await screen.findByRole("heading", { name: "What do you grow on this field now?" });
    expect(screen.getByText("Demo farm (example values)")).toBeInTheDocument();
    expect(screen.getByText("Ready to simulate")).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "Planter" })).toBeChecked();
    // Sourced defaults with their origins, and the demo's own soybean price.
    await screen.findAllByText("Published source");
    expect(within(screen.getByRole("region", { name: "soybean economics" })).getByRole("spinbutton", { name: "Price · typical value" })).toHaveValue(11.2);

    fireEvent.click(screen.getByRole("button", { name: /Next: Simulate current plan/ }));
    await screen.findByRole("heading", { name: "How would your current plan do over 10 years?" });
    expect((await screen.findAllByText(/Replays real past weather in new orders; not a forecast/)).length).toBeGreaterThan(0);
    // The demo's 15% dry-spring loss estimate is labelled as the farmer's.
    expect(screen.getByRole("textbox", { name: /dry spring/ })).toHaveValue("15");

    fireEvent.click(screen.getByRole("button", { name: /Next: Try other plans/ }));
    const add = await screen.findAllByRole("button", { name: "Add to compare" });
    fireEvent.click(add[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Build your own" }));
    expect(screen.getByText(/2 of 5/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Next: Compare/ }));
    await screen.findByRole("region", { name: "Compare scenario plans" });
    expect(screen.getAllByText(/Best of the scenarios you compared/).length).toBeGreaterThan(0);
    const choose = screen.getAllByRole("button", { name: /Choose this plan/ });
    expect(choose).toHaveLength(3);
    fireEvent.click(choose[2]!);

    await screen.findByRole("heading", { name: "What does your chosen plan look like, year by year?" });
    expect(screen.getByRole("region", { name: "Field readings" })).toBeInTheDocument();
    const fieldId = Object.keys(JSON.parse(window.localStorage.getItem("acre.simfield.v1")!).fields)[0]!;
    expect(getSimField(fieldId).chosenId).toMatch(/^s_/);
  });

  it("logs a reading as the farmer's own, kept in the browser", async () => {
    render(<Guided api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /Pergamino/ }));
    await screen.findByRole("heading", { name: "What do you grow on this field now?" });
    act(() => {
      window.location.hash = "#u=plan";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const log = await screen.findByRole("region", { name: "Field readings" });
    fireEvent.change(within(log).getByLabelText("Date", { exact: true }), { target: { value: "2026-04-02" } });
    fireEvent.change(within(log).getByRole("spinbutton", { name: "Soil moisture (%)" }), { target: { value: "21" } });
    fireEvent.click(within(log).getByRole("button", { name: "Add reading" }));
    await waitFor(() => expect(within(log).getAllByText("You entered").length).toBeGreaterThan(1));
  });
});

describe("simulate request", () => {
  const plan = { plan_id: "p", previous_crop_id: "field_corn", prev_harvest: "09-20", winter: { kind: "none" as const }, next_crop_id: "soybean", next_plant: "05-10" };
  it("needs a complete rotation, and leaves out alternatives that are not complete", () => {
    const field = { field_id: "f", name: "F", geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] }, plan: null };
    const sim = { ...getSimField("f"), rotation: [plan] };
    const point = { latitude: 0, longitude: 0 };
    const q = simulateRequest({ field, sim, point }, [{ scenarioId: "a", label: "A", isBaseline: false, rotation: [{ ...plan, next_plant: "" }], from: "custom" }]);
    expect(q?.scenarios.map((s) => s.scenarioId)).toEqual(["current"]);
    expect(simulateRequest({ field, sim: { ...sim, rotation: [] }, point }, [])).toBeNull();
    expect(planReady({ ...plan, winter: { kind: "cover", crop_id: "cereal_rye", seed: "", terminate: "" } })).toBe(false);
    expect(cropsOf([plan, { ...plan, winter: { kind: "cover", crop_id: "cereal_rye", seed: "09-27", terminate: "04-08" } }])).toEqual(["field_corn", "soybean", "cereal_rye"]);
  });
});
