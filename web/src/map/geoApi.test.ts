import { describe, expect, it, vi } from "vitest";
import capsPerg from "../api/fixtures/capabilities-pergamino.json";
import reversePerg from "../api/fixtures/geo-reverse-pergamino.json";
import reverseOcean from "../api/fixtures/geo-reverse-ocean.json";
import searchPerg from "../api/fixtures/geo-search-pergamino.json";
import searchCoords from "../api/fixtures/geo-search-coordinates.json";
import { createFetchGeoApi, parseCapabilities, parseReverse, parseSearch, roundCoord } from "./geoApi";

describe("geo stand-in parsers", () => {
  it("reads a text search with bboxes", () => {
    const r = parseSearch(searchPerg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.queryKind).toBe("text");
    expect(r.data.hits[0]).toEqual({ label: "Pergamino, Buenos Aires, Argentina", point: { latitude: -33.89, longitude: -60.57 }, bbox: [-60.65, -33.95, -60.5, -33.83], kind: "city" });
  });

  it("reads a coordinate search with no bbox", () => {
    const r = parseSearch(searchCoords);
    expect(r.ok && r.data.queryKind).toBe("coordinates");
    expect(r.ok && r.data.hits[0]!.bbox).toBeNull();
  });

  it("drops results without a point and rejects a body with no list", () => {
    const r = parseSearch({ query_kind: "text", results: [{ label: "x", latitude: null, longitude: 3 }] });
    expect(r.ok && r.data.hits).toEqual([]);
    expect(parseSearch({}).ok).toBe(false);
  });

  it("reads a reverse answer", () => {
    const r = parseReverse(reversePerg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ country: "AR", admin1: "AR-B", hemisphere: "south", cellId: "lat-34.00_lon-60.625", onLand: true });
    expect(r.data.climate).toMatchObject({ code: "Cfa", origin: "dataset_estimate" });
  });

  it("keeps an ocean point's status and reason", () => {
    const r = parseReverse(reverseOcean);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe("unsupported");
    expect(r.data.onLand).toBe(false);
    expect(r.data.reasonText).toBeTruthy();
  });

  it("reads capabilities and reports a missing feature as unknown, never available", () => {
    const r = parseCapabilities(capsPerg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = Object.fromEntries(r.data.features.map((f) => [f.key, f]));
    expect(by.catalog).toMatchObject({ status: "partial", origin: "ai_suggested" });
    expect(by.drought).toMatchObject({ status: "unavailable" });
    expect(by.soil).toMatchObject({ provider: "soilgrids", resolutionM: 250 });
    expect(by.tools!.parts.map((p) => p.key)).toContain("irrigation");
    const partial = parseCapabilities({ region_key: null, features: { weather: { status: "complete" } } });
    expect(partial.ok && partial.data.features.find((f) => f.key === "soil")!.status).toBe("unknown");
  });
});

describe("status words", () => {
  it("only the nine status words get through; job words and junk become unknown", () => {
    const r = parseCapabilities({ features: { weather: { status: "ready" }, soil: { status: "available" }, drought: { status: "insufficient_data" } } });
    const by = r.ok ? Object.fromEntries(r.data.features.map((f) => [f.key, f.status])) : {};
    expect(by).toMatchObject({ weather: "unknown", soil: "unknown", drought: "insufficient_data" });
    expect(parseReverse({ status: "ok" }).ok && (parseReverse({ status: "ok" }) as { data: { status: string } }).data.status).toBe("unknown");
  });

  it("tools: one word only when every tool agrees", () => {
    const tools = (t: unknown) => {
      const r = parseCapabilities({ features: { tools: t } });
      return r.ok ? r.data.features.find((f) => f.key === "tools")!.status : null;
    };
    expect(tools({})).toBe("unknown");
    expect(tools({ irrigation: "complete", fertilizer: "complete" })).toBe("complete");
    expect(tools({ irrigation: "complete", fertilizer: "unavailable" })).toBe("partial");
    expect(tools({ irrigation: "unavailable" })).toBe("unavailable");
  });

  it("tools: never \"partly available\" when no tool can be used", () => {
    const tools = (t: unknown) => {
      const r = parseCapabilities({ features: { tools: t } });
      return r.ok ? r.data.features.find((f) => f.key === "tools")!.status : null;
    };
    // Mixed, none usable: the group is not available, and an unreported tool keeps the group unknown.
    expect(tools({ irrigation: "unsupported", fertilizer: "inapplicable" })).toBe("unavailable");
    expect(tools({ irrigation: "unavailable", fertilizer: "unsupported", zones: "inapplicable" })).toBe("unavailable");
    expect(tools({ irrigation: "unavailable", fertilizer: "unknown" })).toBe("unknown");
    expect(tools({ irrigation: "unsupported", fertilizer: "not_a_word" })).toBe("unknown");
    // Mixed with one usable tool is still partial, whichever way round.
    expect(tools({ irrigation: "unsupported", fertilizer: "partial" })).toBe("partial");
    expect(tools({ irrigation: "unknown", fertilizer: "complete" })).toBe("partial");
    // The per-tool words are untouched.
    const r = parseCapabilities({ features: { tools: { irrigation: "unsupported", fertilizer: "inapplicable" } } });
    expect(r.ok && r.data.features.find((f) => f.key === "tools")!.parts).toEqual([
      { key: "irrigation", status: "unsupported" },
      { key: "fertilizer", status: "inapplicable" },
    ]);
  });
});

describe("createFetchGeoApi", () => {
  it("builds the contract URLs and passes typed errors through", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v1/geo/search")) return new Response(JSON.stringify(searchPerg), { status: 200 });
      return new Response(JSON.stringify({ issues: [{ field: "lat", code: "invalid_input", message: "Latitude must be between -90 and 90." }] }), { status: 400 });
    });
    const api = createFetchGeoApi("http://x.test/", fetchImpl as unknown as typeof fetch);
    const s = await api.search("Pergamino, BA");
    expect(s.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://x.test/v1/geo/search?q=Pergamino%2C%20BA&limit=5");
    const rev = await api.reverse(99, 0);
    expect(rev).toEqual({ ok: false, message: "Latitude must be between -90 and 90." });
  });

  it("says when the service cannot be reached", async () => {
    const api = createFetchGeoApi("http://x.test", (async () => {
      throw new TypeError("fail");
    }) as unknown as typeof fetch);
    expect(await api.capabilities(1, 2)).toEqual({ ok: false, message: "The service could not be reached." });
  });
});

it("rounds a picked point to 5 decimals", () => {
  expect(roundCoord(-33.8912345678)).toBe(-33.89123);
});
