import { useEffect, useState } from "react";
import type { GlobalClient, Result } from "../api/client";
import type { SimulateRequest } from "../api/adapt";
import type { Simulation } from "../api/simModel";

/*
  Runs POST /v1/scenarios/simulate and keeps each answer for this page, keyed by the full
  request, so stepping Back and Next does not re-run a 200-replay simulation. Nothing is
  computed here; the answer is the backend's.
*/
export type SimState = { state: "idle" } | { state: "loading"; note?: string } | { state: "error"; message: string; detail: string | null } | { state: "ready"; data: Simulation };

const cache = new Map<string, SimState>();
const listeners = new Set<() => void>();
const keyOf = (q: SimulateRequest) => JSON.stringify(q);

export function peekSimulation(q: SimulateRequest | null): SimState {
  return q ? (cache.get(keyOf(q)) ?? { state: "idle" }) : { state: "idle" };
}

export function runSimulation(client: GlobalClient, q: SimulateRequest): Promise<void> {
  const key = keyOf(q);
  const cur = cache.get(key);
  if (cur?.state === "loading" || cur?.state === "ready") return Promise.resolve();
  const set = (s: SimState) => {
    cache.set(key, s);
    listeners.forEach((l) => l());
  };
  set({ state: "loading" });
  return (async () => {
    let r: Result<Simulation> = await client.simulate(q);
    // A field whose weather cell has not been fetched yet: fetch it from NASA POWER, then run again.
    if (r.ok && r.data.status === "unavailable" && r.data.raw.code === "weather_not_prepared") {
      set({ state: "loading", note: "Fetching this field's past weather from NASA for the first time. This can take a minute or two." });
      const ready = await prepareWeather(client, q.point);
      if (!ready.ok) {
        set({ state: "error", message: ready.message, detail: null });
        return;
      }
      set({ state: "loading", note: "Weather is ready. Running the simulation…" });
      r = await client.simulate(q);
    }
    set(r.ok ? { state: "ready", data: r.data } : { state: "error", message: r.message, detail: "detail" in r ? (r.detail ?? null) : null });
  })();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Starts the weather fetch for the field's cell and polls it until it is ready (bounded to about 4 minutes). */
async function prepareWeather(client: GlobalClient, point: SimulateRequest["point"]): Promise<{ ok: true } | { ok: false; message: string }> {
  const start = await client.prepareWeather(point);
  if (!start.ok) return { ok: false, message: start.message };
  let cell = start.data;
  for (let i = 0; i < 80; i++) {
    if (cell.jobStatus === "ready" || cell.status === "complete" || cell.status === "partial") return { ok: true };
    if (cell.jobStatus === "failed") return { ok: false, message: cell.reasonText ?? "NASA weather for this field could not be fetched. Try again later." };
    await wait(3000);
    const next = cell.cellId ? await client.weather(cell.cellId) : await client.prepareWeather(point);
    if (next.ok) cell = next.data;
  }
  return { ok: false, message: "Fetching NASA weather for this field is taking longer than expected. Try again in a few minutes." };
}

/** The simulation for this request; runs it once when `auto` is set and nothing is cached. */
export function useSimulation(client: GlobalClient, q: SimulateRequest | null, auto: boolean): { sim: SimState; run: () => void } {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const key = q ? keyOf(q) : null;
  useEffect(() => {
    if (auto && q && !cache.has(keyOf(q))) void runSimulation(client, q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, auto]);
  return {
    sim: peekSimulation(q),
    run: () => {
      if (!q) return;
      cache.delete(keyOf(q));
      void runSimulation(client, q);
    },
  };
}

export function clearSimulationsForTests() {
  cache.clear();
}
