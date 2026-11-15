import { useEffect, useState } from "react";

/*
  Where the U2 (web/src/sim), U3 (web/src/inputs) and U4 (web/src/timeline) components mount.
  Each module is found with import.meta.glob, so this builds before those branches are merged;
  until a module exports the named component, the step shows D's own view of the same data.
*/
type Mod = Record<string, unknown>;
const SIM = import.meta.glob<Mod>("../../sim/index.ts");
const INPUTS = import.meta.glob<Mod>("../../inputs/index.ts");
const TIMELINE = import.meta.glob<Mod>("../../timeline/index.ts");

const loaded = new Map<string, Mod | null>();
function useGlobModule(glob: Record<string, () => Promise<Mod>>, key: string): Mod | null {
  const [mod, setMod] = useState<Mod | null>(() => loaded.get(key) ?? null);
  useEffect(() => {
    if (loaded.has(key)) return;
    const load = Object.values(glob)[0];
    if (!load) {
      loaded.set(key, null);
      return;
    }
    let live = true;
    load()
      .then((m) => {
        loaded.set(key, m);
        if (live) setMod(m);
      })
      .catch(() => loaded.set(key, null));
    return () => {
      live = false;
    };
  }, [glob, key]);
  return mod;
}

export const useSimModule = () => useGlobModule(SIM, "sim");
export const useInputsModule = () => useGlobModule(INPUTS, "inputs");
export const useTimelineModule = () => useGlobModule(TIMELINE, "timeline");

/** The named export as a component, or null when the module or export is not there yet. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pick<P = any>(mod: Mod | null, name: string): React.ComponentType<P> | null {
  const c = mod?.[name];
  return typeof c === "function" || (typeof c === "object" && c !== null) ? (c as React.ComponentType<P>) : null;
}
