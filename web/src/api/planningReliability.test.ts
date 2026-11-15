import { afterEach, describe, expect, it, vi } from "vitest";
import { createGlobalClient, PLANNING_TIMEOUT_MS, type FetchLike } from "./client";
import { FIXTURE_API_BASE, fixtureFetch } from "./fixtures";

const place = { point: { latitude: 34.98, longitude: -80.55 } };
afterEach(() => vi.useRealTimers());

describe("planning requests", () => {
  it("shares a concurrent recommendation but keeps different goals separate", async () => {
    const fixture = fixtureFetch();
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      await Promise.resolve();
      return fixture(url, init);
    });
    const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 20_000, fetchImpl });
    const a = client.recommend(place, null);
    const b = client.recommend(place, null);
    const c = client.recommend(place, { priorities: { soil_cover: 3 } });
    const results = await Promise.all([a, b, c]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("allows a recommendation to finish after the normal 20-second data deadline", async () => {
    vi.useFakeTimers();
    const fixture = fixtureFetch();
    const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 20_000, fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => void fixture(url, init).then(resolve), 25_000);
    }) });
    const request = client.recommend(place, null);
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await request).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(PLANNING_TIMEOUT_MS).toBeGreaterThan(25_000);
  });

  it("releases a failed request so Try again sends a fresh request", async () => {
    const fixture = fixtureFetch();
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce({ ok: false, status: 500, text: async () => "{}" }).mockImplementation(fixture);
    const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 1000, fetchImpl });
    expect((await client.recommend(place, null)).ok).toBe(false);
    expect((await client.recommend(place, null)).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
