import type { Simulation } from "../api/simModel";

/*
  The last result for each field, kept on the device (card 20), so a grower with no connection
  still sees their plan's numbers with the date they were worked out. One entry per field and
  kind of run ("current" for the plan alone, "compare" for the plans side by side), in the
  browser's own database; nothing leaves the device. A saved result is only ever shown as
  saved, with its date: it is never passed off as a fresh answer.
*/
export interface SavedResult {
  id: string;
  /** The exact request the result answered, to tell whether the grower's answers have changed since. */
  requestKey: string;
  savedAt: string;
  data: Simulation;
}
export interface SavedStore {
  get(id: string): Promise<SavedResult | null>;
  put(entry: SavedResult): Promise<void>;
}

const DB = "acre-saved-v1";
const STORE = "results";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const browserStore: SavedStore = {
  async get(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as SavedResult | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  },
  async put(entry) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

let store: SavedStore | null = typeof indexedDB !== "undefined" ? browserStore : null;
/** Tests supply their own store (jsdom has no database). `null` switches saving off. */
export function setSavedStoreForTests(s: SavedStore | null) {
  store = s;
}
export function memoryStore(): SavedStore {
  const m = new Map<string, SavedResult>();
  return { get: async (id) => m.get(id) ?? null, put: async (e) => void m.set(e.id, e) };
}

export const savedId = (fieldId: string, scenarios: number) => `${fieldId}|${scenarios > 1 ? "compare" : "current"}`;

/** Keeps a result; a device that cannot store it (private mode, full disk) simply goes without. */
export async function saveResult(id: string, requestKey: string, data: Simulation, now = new Date()): Promise<void> {
  if (!store) return;
  try {
    await store.put({ id, requestKey, savedAt: now.toISOString(), data });
  } catch {
    /* nothing to do: the result is still on screen */
  }
}
export async function loadResult(id: string): Promise<SavedResult | null> {
  if (!store) return null;
  try {
    return await store.get(id);
  } catch {
    return null;
  }
}
