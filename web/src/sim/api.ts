import { z } from "zod";
import { simulateRequestSchema, simulationResultSchema, type SimulateRequestInput, type SimulationResult } from "./schema";

export class SimulationApiError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "SimulationApiError";
  }
}

export async function simulateScenarios(request: SimulateRequestInput, signal?: AbortSignal): Promise<SimulationResult> {
  const body = simulateRequestSchema.parse(request);
  let response: Response;
  try {
    response = await fetch(`${(import.meta.env.VITE_API_BASE ?? "http://localhost:8000").replace(/\/$/, "")}/v1/scenarios/simulate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
  } catch (error) {
    if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SimulationApiError("The simulation service could not be reached. Your plan is still in this browser.");
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new SimulationApiError("The simulation service returned an unreadable response.", response.status); }
  if (!response.ok) {
    const error = z.object({ reason_text: z.string().nullable().optional() }).safeParse(payload);
    throw new SimulationApiError(error.success && error.data.reason_text || `The simulation request failed (${response.status}).`, response.status);
  }
  const result = simulationResultSchema.safeParse(payload);
  if (!result.success) throw new SimulationApiError("The simulation response does not match the API contract. Check the service version.", response.status);
  return result.data;
}
