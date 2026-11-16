import { afterEach, describe, expect, it, vi } from "vitest";
import { greenMonths, greenTiles, likelyMonths, monthsFromDomain, resetGreenMonthsForTests } from "./greenLayer";

const DOMAIN = "<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2000-03-01/2025-03-01/P1M,2025-05-01/2026-10-01/P1M</Domain><Size>2</Size></DimensionDomain></Domains>";
afterEach(resetGreenMonthsForTests);

describe("NASA's greenness layer by month (card 28)", () => {
  it("offers only the months NASA has, newest first, and never a month it lost", () => {
    const months = monthsFromDomain(DOMAIN);
    expect(months[0]).toBe("2026-10");
    expect(months).toContain("2025-05");
    expect(months).toContain("2025-03");
    expect(months).not.toContain("2025-04"); // the gap in NASA's own list
    expect(months).not.toContain("2026-11");
    expect(months).toHaveLength(60);
    expect(monthsFromDomain("<html>not found</html>")).toEqual([]);
  });

  it("asks NASA once, and falls back to the months up to two months ago when it cannot", async () => {
    const ok = vi.fn(async (_url: string) => new Response(DOMAIN));
    expect((await greenMonths(ok as unknown as typeof fetch))[0]).toBe("2026-10");
    await greenMonths(ok as unknown as typeof fetch);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(String(ok.mock.calls[0]![0])).toMatch(/^https:\/\/gibs\.earthdata\.nasa\.gov\/.*MODIS_Terra_L3_NDVI_Monthly/);
    resetGreenMonthsForTests();
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect(await greenMonths(down as unknown as typeof fetch)).toEqual(likelyMonths());
    expect(likelyMonths(new Date(Date.UTC(2026, 10, 16)))[0]).toBe("2026-09");
    expect(likelyMonths(new Date(Date.UTC(2026, 0, 5)))[0]).toBe("2025-11");
  });

  it("builds the tile address for a month and sends nothing about the grower", () => {
    const url = greenTiles("2026-10");
    expect(url).toBe("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_NDVI_Monthly/default/2026-10-01/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png");
    expect(url).not.toMatch(/key|token|lat|lon/i);
  });
});
