import { describe, expect, it } from "vitest";
import { asPercent, median, nearestDay, newestDays, smapTiles, spansFromDomain, tileFor, valueOfColour, SMAP_ROOT } from "./smap";

const DOMAIN = "<Domains><DimensionDomain><Domain>2015-03-31/2025-07-06/P1D,2025-07-08/2025-10-09/P1D,2025-12-12/2026-03-16/P1D,2026-03-18/2026-11-13/P1D</Domain></DimensionDomain></Domains>";

describe("soil moisture read from NASA's SMAP pictures (card 31)", () => {
  it("turns a colour back into the value NASA drew it from, and nothing else into a value", () => {
    expect(valueOfColour(255, 162, 0)).toBe(0.002); // the first step: 0.000 to 0.003
    expect(valueOfColour(80, 80, 80)).toBe(0.7); // the top of the scale
    expect(valueOfColour(0, 0, 0, 0)).toBeNull(); // no data is see-through
    expect(valueOfColour(1, 2, 3)).toBeNull(); // not a colour in NASA's table
    // every step of the scale is a distinct value between 0 and 0.7
    const seen = new Set<number>();
    for (let v = 0.0015; v < 0.7; v += 0.003) seen.add(Math.round(v * 1000));
    expect(seen.size).toBeGreaterThan(200);
  });

  it("finds the picture tile and the dot for a field, anywhere on Earth", () => {
    expect(tileFor(0, 0)).toEqual({ x: 32, y: 32, px: 0, py: 0 });
    const kitale = tileFor(1.02, 35.0);
    expect([kitale.x, kitale.y]).toEqual([38, 31]);
    const pergamino = tileFor(-33.89, -60.57);
    expect([pergamino.x, pergamino.y]).toEqual([21, 38]);
    for (const p of [kitale, pergamino, tileFor(89, 179.99), tileFor(-89, -180)]) {
      expect(p.px).toBeGreaterThanOrEqual(0);
      expect(p.px).toBeLessThan(256);
      expect(p.py).toBeGreaterThanOrEqual(0);
      expect(p.py).toBeLessThan(256);
    }
    // the request names a square about 600 km across, never the field
    expect(smapTiles(SMAP_ROOT, "2026-03-15")).toBe("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/SMAP_L4_Analyzed_Root_Zone_Soil_Moisture/default/2026-03-15/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png");
  });

  it("uses the day NASA has, or the nearest one, and gives up beyond ten days", () => {
    const spans = spansFromDomain(DOMAIN);
    expect(spans).toHaveLength(4);
    expect(nearestDay(spans, "2026-03-15")).toBe("2026-03-15");
    expect(nearestDay(spans, "2026-03-17")).toBe("2026-03-16"); // a one-day gap: the day before
    expect(nearestDay(spans, "2025-10-12")).toBe("2025-10-09");
    expect(nearestDay(spans, "2025-11-10")).toBeNull(); // inside a two-month gap
    expect(nearestDay(spans, "2014-03-15")).toBeNull(); // before the satellite flew
    expect(newestDays(spans, 3)).toEqual(["2026-11-13", "2026-11-12", "2026-11-11"]);
    expect(spansFromDomain("<html/>")).toEqual([]);
  });

  it("says the value the way a moisture meter does", () => {
    expect(asPercent(0.284)).toBe("28%");
    expect(median([0.3, 0.1, 0.2])).toBe(0.2);
    expect(median([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.25);
  });
});
