import { useEffect, useState } from "react";
import type { GlobalClient, Result } from "../api/client";
import type { SimulateRequest } from "../api/adapt";
import type { Simulation } from "../api/simModel";

/*
  Runs POST /v1/scenarios/simulate and keeps each answer for this page, keyed by the full
  request, so stepping Back and Next does not re-run a 200-replay simulation. Nothing is
  computed here; the answer is the backend's.
*/
export type SimState = { state: "idle" } | { state: "loading" } | { state: "error"; message: string; detail: string | null } | { state: "ready"; data: Simulation };

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
  cache.set(key, { state: "loading" });
  listeners.forEach((l) => l());
  return client.simulate(q).then((r: Result<Simulation>) => {
    cache.set(key, r.ok ? { state: "ready", data: r.data } : { state: "error", message: r.message, detail: "detail" in r ? (r.detail ?? null) : null });
    listeners.forEach((l) => l());
  });
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
