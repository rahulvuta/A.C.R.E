import { beforeEach, describe, expect, it } from "vitest";
import { parseSaved } from "./storageBackup";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    get length() { return values.size; }, clear: () => values.clear(), getItem: (k: string) => values.get(k) ?? null,
    key: (i: number) => [...values.keys()][i] ?? null, removeItem: (k: string) => values.delete(k), setItem: (k: string, v: string) => values.set(k, String(v)),
  } satisfies Storage });
});

describe("saved per-field stores", () => {
  it("parses readable text and leaves no backup", () => {
    expect(parseSaved("acre.simfield.v1", '{"fields":{}}')).toEqual({ fields: {} });
    expect(window.localStorage.getItem("acre.simfield.v1.unreadable")).toBeNull();
  });
  it("keeps a copy of unreadable text instead of letting the next save wipe it", () => {
    expect(parseSaved("acre.simfield.v1", "{not json")).toBeNull();
    expect(window.localStorage.getItem("acre.simfield.v1.unreadable")).toBe("{not json");
  });
});
