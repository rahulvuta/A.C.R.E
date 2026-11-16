import { afterEach, describe, expect, it } from "vitest";
import type { GlobalClient } from "../api/client";
import type { SimulateRequest } from "../api/adapt";
import type { Simulation } from "../api/simModel";
import { loadResult, memoryStore, savedId, setSavedStoreForTests } from "./savedResults";
import { clearSimulationsForTests, peekSimulation, runSimulation } from "./useSimulation";

const request = (loss: number | null = null): SimulateRequest => ({ point: { latitude: 1, longitude: 35 }, field: { fieldId: "fld_a", name: "A", areaHa: 2, equipment: [], readings: [] }, priorities: {}, overrides: {}, loss: { drySpringPct: loss, wetSpringPct: null, heavyRainPct: null }, scenarios: [{ scenarioId: "current", label: "What I do now", isBaseline: true, rotation: [], from: "current" }], startSeason: "2027" }) as unknown as SimulateRequest;
const answer = { status: "complete", scenarios: [{ scenarioId: "current", label: "What I do now" }], raw: {} } as unknown as Simulation;
const client = (simulate: () => Promise<unknown>) => ({ simulate }) as unknown as GlobalClient;
const down = async () => ({ ok: false as const, kind: "network" as const, message: "The service could not be reached." });

afterEach(() => {
  clearSimulationsForTests();
  setSavedStoreForTests(null);
});

describe("a weak connection (card 20)", () => {
  it("keeps the last result for a field and shows it, with its date, when the service cannot be reached", async () => {
    setSavedStoreForTests(memoryStore());
    await runSimulation(client(async () => ({ ok: true, data: answer })), request());
    await Promise.resolve();
    expect((await loadResult(savedId("fld_a", 1)))?.data).toEqual(answer);

    // The page is opened again with no connection.
    clearSimulationsForTests();
    await runSimulation(client(down), request());
    const shown = peekSimulation(request());
    expect(shown.state).toBe("ready");
    expect(shown.state === "ready" && shown.saved?.sameInputs).toBe(true);
    expect(shown.state === "ready" && shown.saved && !Number.isNaN(Date.parse(shown.saved.at))).toBe(true);
  });

  it("says so when the grower's answers have changed since the saved result", async () => {
    setSavedStoreForTests(memoryStore());
    await runSimulation(client(async () => ({ ok: true, data: answer })), request());
    await Promise.resolve();
    clearSimulationsForTests();
    await runSimulation(client(down), request(25));
    const shown = peekSimulation(request(25));
    expect(shown.state === "ready" && shown.saved?.sameInputs).toBe(false);
  });

  it("still reports the failure when nothing was saved, and never shows a saved result for input the service refused", async () => {
    setSavedStoreForTests(memoryStore());
    await runSimulation(client(down), request());
    expect(peekSimulation(request()).state).toBe("error");
    clearSimulationsForTests();
    await runSimulation(client(async () => ({ ok: true, data: answer })), request());
    await Promise.resolve();
    clearSimulationsForTests();
    await runSimulation(client(async () => ({ ok: false as const, kind: "invalid" as const, message: "The service could not accept this input." })), request());
    expect(peekSimulation(request()).state).toBe("error");
  });
});
