import { z } from "zod";
import { autofillRequestSchema, autofillResponseSchema, cropSchema, cropSearchSchema, economicsRequestSchema, economicsResponseSchema, equipmentResponseSchema, researchJobSchema, type AutofillRequest, type EconomicsRequest } from "./schema";

export class InputsApiError extends Error {
  constructor(message: string, public readonly httpStatus?: number) { super(message); this.name = "InputsApiError"; }
}
type InputsFetch = (url: string, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
export function createInputsApi(base = import.meta.env.VITE_API_BASE ?? "http://localhost:8000", fetchImpl: InputsFetch = (url, init) => fetch(url, init)) {
  async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${base.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST", signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    let payload: unknown;
    try { payload = JSON.parse(await response.text()); } catch { throw new InputsApiError("The service returned an unreadable response. Your entries are still here.", response.status); }
    if (!response.ok) {
      const parsed = z.object({ reason_text: z.string().nullable().optional(), issues: z.array(z.object({ field: z.string(), message: z.string() })).optional() }).safeParse(payload);
      throw new InputsApiError(parsed.success ? parsed.data.issues?.map(i => `${i.field}: ${i.message}`).join(" ") || parsed.data.reason_text || `Service unavailable (${response.status}). Your entries are still here.` : `Service unavailable (${response.status}). Your entries are still here.`, response.status);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new InputsApiError("The response does not match the input API contract. Your entries are still here.");
    return parsed.data;
  }
  return {
    search: (query: string, regionKey: string, signal?: AbortSignal) => request(`/v1/crops/search?${new URLSearchParams({ q: query, region_key: regionKey })}`, cropSearchSchema, signal),
    research: (name: string, regionKey: string, signal?: AbortSignal) => request("/v1/crops/research", researchJobSchema, signal, { name, region_key: regionKey }),
    researchJob: (jobId: string, signal?: AbortSignal) => request(`/v1/crops/research/${encodeURIComponent(jobId)}`, researchJobSchema, signal),
    crop: (cropId: string, regionKey: string, signal?: AbortSignal) => request(`/v1/crops/${encodeURIComponent(cropId)}?${new URLSearchParams({ region_key: regionKey })}`, cropSchema, signal),
    autofill: (body: AutofillRequest, signal?: AbortSignal) => request("/v1/plans/autofill", autofillResponseSchema, signal, autofillRequestSchema.parse(body)),
    estimate: (body: EconomicsRequest, signal?: AbortSignal) => request("/v1/economics/estimate", economicsResponseSchema, signal, economicsRequestSchema.parse({ ...body, area: body.area?.value != null && body.area.value > 0 ? body.area : null })),
    equipment: (signal?: AbortSignal) => request("/v1/vocab/equipment", equipmentResponseSchema, signal),
  };
}
export type InputsApi = ReturnType<typeof createInputsApi>;
export const inputsApi = createInputsApi();
