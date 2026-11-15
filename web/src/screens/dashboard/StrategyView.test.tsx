import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBackendSimulate } from "../../api/adapt";
import { createGlobalClient, type GlobalClient } from "../../api/client";
import { FIXTURE_API_BASE, fixtureFetch, FIXTURES } from "../../api/fixtures";
import { geoApiFrom } from "../../api/geoApi";
import type { Scenario } from "../../api/simModel";
import type { Field, FieldPlan } from "../../farm/types";
import { emptySimField, type SimField } from "../../state/simField";
import type { GlobalApi } from "../../state/useGlobal";
import { clearSimulationsForTests } from "../../state/useSimulation";
import type { StepContext } from "../guided/context";
import { HORIZON_YEARS, outlookBasis, StrategyView } from "./StrategyBoxes";
import { climateAdjustmentOf } from "./StrategySim";
import request from "../../timeline/fixtures/simulate-union.request.json";

// SYNTHETIC FIXTURES: the Union County sample request and the repo's simulate fixture, used only to test rendering.
const scenarios = (request as unknown as { scenarios: Array<{ scenario_id: string; label: string; rotation: FieldPlan[] }> }).scenarios;
const alt = (i: number): Scenario => ({ scenarioId: scenarios[i]!.scenario_id, label: scenarios[i]!.label, isBaseline: false, rotation: scenarios[i]!.rotation, from: "suggested" });
const field: Field = { field_id: "fld_t", name: "Test field", geometry: { type: "Polygon", coordinates: [[[-80.5, 34.9], [-80.497, 34.9], [-80.497, 34.903], [-80.5, 34.903], [-80.5, 34.9]]] }, plan: null };
const sim: SimField = { ...emptySimField(), rotation: scenarios[0]!.rotation, scenarios: [alt(1), alt(2)], demo: "Demo farm (example values)" };

let bodies: Array<Record<string, unknown>> = [];
function ctxWith(simulateRaw?: unknown): StepContext {
  const fetchImpl = fixtureFetch();
  const client: GlobalClient = createGlobalClient({
    apiBase: FIXTURE_API_BASE,
    timeoutMs: 2000,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/v1/scenarios/simulate") && init?.body) bodies.push(JSON.parse(String(init.body)));
      if (simulateRaw && String(url).endsWith("/v1/scenarios/simulate")) {
        const text = JSON.stringify(simulateRaw);
        return { ok: true, status: 200, text: async () => text, headers: { get: () => "application/json" } };
      }
      return fetchImpl(url, init);
    },
  });
  const api: GlobalApi = { client, geo: geoApiFrom(client), source: "fixtures" };
  return { api, farm: null, field, sim, point: { latitude: 34.9, longitude: -80.5 }, regionKey: null, profile: null, go: () => {} };
}

beforeEach(() => {
  bodies = [];
  clearSimulationsForTests();
});
afterEach(cleanup);

describe("HORIZON_YEARS and the request", () => {
  it("is 10, and toBackendSimulate sends climate trend by default and none when asked", () => {
    expect(HORIZON_YEARS).toBe(10);
    const q = { point: { latitude: 0, longitude: 0 }, field: { fieldId: "f", name: "Synthetic test", areaHa: null, equipment: [], readings: [] }, priorities: {}, overrides: {}, loss: sim.loss, scenarios: [], startSeason: "2027" };
    expect(toBackendSimulate(q).climate).toBe("trend");
    expect(toBackendSimulate({ ...q, climate: "none" }).climate).toBe("none");
    expect(toBackendSimulate({ ...q, climate: "trend" }).climate).toBe("trend");
  });
});

describe("the outlook view", () => {
  it("asks for 10 years with the trend adjustment, and says outlook but never forecast", async () => {
    const { container } = render(<StrategyView ctx={ctxWith()} onTab={() => {}} />);
    await screen.findByLabelText("What this outlook is built on");
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(bodies[0]!.years).toBe(10);
    expect(bodies[0]!.climate).toBe("trend");
    expect(screen.getByRole("heading", { name: "The next 10 years, plan by plan" })).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).toMatch(/outlook/i);
    expect(text).not.toMatch(/not a forecast/i);
    expect(text).not.toMatch(/\bforecast/i);
  });

  it("the small print at the bottom shows the record, the run count and the backend's climate sentence", async () => {
    render(<StrategyView ctx={ctxWith()} onTab={() => {}} />);
    const panel = await screen.findByLabelText("What this outlook is built on");
    expect(panel.tagName).toBe("FOOTER");
    expect(panel.parentElement!.lastElementChild).toBe(panel);
    const text = panel.textContent ?? "";
    expect(text).toContain("45 past seasons observed at this field (1981-2025), from NASA weather data for the surrounding ~50 km area.");
    expect(text).toContain("Each plan is run through the next 10 years 200 times");
    expect(text).toMatch(/No statistically clear trend in yearly rain at this field since 1981/);
    expect(text).toMatch(/cannot say what any single year will bring\./);
  });

  it("renders without the climate line, and without crashing, when the block is absent", async () => {
    const raw = JSON.parse(JSON.stringify(FIXTURES.simulateUnion));
    delete raw.method.climate_adjustment;
    delete raw.method.pool_years;
    render(<StrategyView ctx={ctxWith(raw)} onTab={() => {}} />);
    const panel = await screen.findByLabelText("What this outlook is built on");
    const text = panel.textContent ?? "";
    expect(text).not.toMatch(/trend/i);
    expect(text).not.toMatch(/past seasons observed/);
    expect(text).toMatch(/run through the next 10 years 200 times/);
  });
});

describe("outlookBasis", () => {
  const method = (m: Record<string, unknown>) => ({ method: m });
  it("builds a sentence from `applied` when the block has no text", () => {
    expect(outlookBasis(method({ climate_adjustment: { applied: true } }), 200, null).some((l) => l === "Rain is adjusted for the trend observed in this field's record.")).toBe(true);
    expect(outlookBasis(method({ climate_adjustment: { applied: false } }), 200, null).some((l) => l.startsWith("Rain is used as recorded; no clear trend"))).toBe(true);
  });
  it("omits lines whose values are absent, and ignores a malformed block", () => {
    const lines = outlookBasis({ method: { climate_adjustment: "nope" } }, null, null);
    expect(lines).toHaveLength(2); // only the money and the closing sentence
    expect(climateAdjustmentOf({ method: { climate_adjustment: { precip_trend: { significant: "x" } } } })).toBeNull();
    expect(climateAdjustmentOf(null)).toBeNull();
  });
});

it("waits until the overview is visible before starting a simulation", async () => {
  const ctx = ctxWith();
  const { rerender } = render(<StrategyView ctx={{ ...ctx, active: false }} onTab={() => {}} />);
  expect(bodies).toHaveLength(0);
  rerender(<StrategyView ctx={{ ...ctx, active: true }} onTab={() => {}} />);
  await screen.findByLabelText("What this outlook is built on");
  expect(bodies).toHaveLength(1);
  const rotation = ctx.sim.rotation.map((p) => ({ ...p, next_plant: "05-11" }));
  rerender(<StrategyView ctx={{ ...ctx, active: false, sim: { ...ctx.sim, rotation } }} onTab={() => {}} />);
  expect(bodies).toHaveLength(1);
});
