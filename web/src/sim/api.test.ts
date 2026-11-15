import { SimulationApiError, simulateScenarios } from "./api";
import { simulateRequestExample, simulationExample } from "./fixtures";
import { simulateRequestSchema, simulationResultSchema } from "./schema";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("posts a validated request to the configured base and validates the response", async () => {
  vi.stubEnv("VITE_API_BASE", "https://example.test/api/");
  const mock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => simulationExample });
  vi.stubGlobal("fetch", mock);
  const signal = new AbortController().signal;
  const result = await simulateScenarios(simulateRequestExample, signal);
  expect(result.scenarios[1]?.totals?.margin_10y?.median).toBe(142000);
  expect(mock).toHaveBeenCalledWith("https://example.test/api/v1/scenarios/simulate", expect.objectContaining({ method: "POST", signal, body: JSON.stringify(simulateRequestExample) }));
});

it("uses the required localhost base by default", async () => {
  vi.stubEnv("VITE_API_BASE", undefined);
  const mock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => simulationExample });
  vi.stubGlobal("fetch", mock);
  await simulateScenarios(simulateRequestExample);
  expect(mock.mock.calls[0]?.[0]).toBe("http://localhost:8000/v1/scenarios/simulate");
});

it.each([{ years: 0 }, { years: 11 }, { runs: 49 }, { runs: 501 }, { scenarios: [] }, { scenarios: Array(7).fill(simulateRequestExample.scenarios[0]) }, { scenarios: [simulateRequestExample.scenarios[0], simulateRequestExample.scenarios[0]] }])("rejects an invalid simulation request before fetching: %j", async patch => {
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  expect(simulateRequestSchema.safeParse({ ...simulateRequestExample, ...patch }).success).toBe(false);
  await expect(simulateScenarios({ ...simulateRequestExample, ...patch })).rejects.toThrow();
  expect(mock).not.toHaveBeenCalled();
});

it("rejects an invalid response instead of replacing it with examples", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...simulationExample, scenarios: [{ ...simulationExample.scenarios[0], events: [{ event: "dry", probability: 8 }] }] }) }));
  await expect(simulateScenarios(simulateRequestExample)).rejects.toThrow(/does not match the API contract/);
  expect(simulationResultSchema.safeParse({ ...simulationExample, scenarios: [{ ...simulationExample.scenarios[0], status: "pending" }] }).success).toBe(false);
});

it("keeps missing provenance and blank money without defaulting to zero", () => {
  const result = simulationResultSchema.parse({ status: "partial", scenarios: [{ scenario_id: "s", label: "Example", status: "partial", money_status: "unavailable", totals: { margin_10y: { median: null }, living_cover_days_per_year: { median: 190 }, crop_families: 2 } }] });
  expect(result.scenarios[0]?.totals?.margin_10y?.median).toBeNull();
  expect(result.scenarios[0]?.totals?.margin_10y?.origin).toBeUndefined();
});

it.each([
  [{ ok: false, status: 503, json: async () => ({ reason_text: "Historical weather is not ready." }) }, "Historical weather is not ready."],
  [{ ok: true, status: 200, json: async () => { throw new Error("bad JSON"); } }, "unreadable response"],
] as const)("reports service failures", async (response, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(simulateScenarios(simulateRequestExample)).rejects.toThrow(message);
});

it("reports connection errors and passes cancellation through", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  await expect(simulateScenarios(simulateRequestExample)).rejects.toBeInstanceOf(SimulationApiError);
  const aborted = new DOMException("Aborted", "AbortError");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
  await expect(simulateScenarios(simulateRequestExample)).rejects.toBe(aborted);
});
