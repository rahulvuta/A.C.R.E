import { useCallback, useEffect, useRef, useState } from "react";
import type { GlobalClient } from "../api/client";
import type { FarmAnalysis } from "../api/model";
import type { Farm } from "../farm/types";

/*
  POST /v1/farms/analyze for the selected farm (card D2). Runs when asked; while any field's
  weather is still being fetched it asks again every few seconds, up to a bounded number of
  times, so nothing spins forever. Results are kept per farm until the farm changes.
*/
export type AnalysisState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string; issues: string[] }
  | { state: "ready"; data: FarmAnalysis; stale: boolean };

const POLL_MS = 4000;
const MAX_POLLS = 15;

export function useFarmAnalysis(client: GlobalClient, farm: Farm | null) {
  const [st, setSt] = useState<AnalysisState>({ state: "idle" });
  const run = useRef(0);
  const analyzedAt = useRef<string | null>(null);

  const analyze = useCallback(
    async (f: Farm | null = farm, poll = 0) => {
      if (!f) return;
      const id = ++run.current;
      if (poll === 0) setSt({ state: "loading" });
      const r = await client.analyzeFarm(f);
      if (id !== run.current) return;
      if (!r.ok) {
        const issues = (r as { issues?: Array<{ message: string }> }).issues?.map((i) => i.message) ?? [];
        setSt({ state: "error", message: r.message, issues: issues.length ? issues : r.detail ? [r.detail] : [] });
        return;
      }
      analyzedAt.current = f.updated_at;
      setSt({ state: "ready", data: r.data, stale: false });
      if (r.data.fields.some((x) => x.jobStatus === "pending") && poll < MAX_POLLS) {
        setTimeout(() => {
          if (id === run.current) void analyze(f, poll + 1);
        }, POLL_MS);
      }
    },
    [client, farm],
  );

  // A different farm drops the old results; an edited farm marks them out of date.
  const farmId = farm?.farm_id ?? null;
  useEffect(() => {
    run.current++;
    setSt({ state: "idle" });
  }, [farmId]);
  const stale = st.state === "ready" && farm != null && analyzedAt.current !== farm.updated_at;

  return { analysis: st.state === "ready" ? { ...st, stale } : st, analyze: () => analyze(farm) };
}
