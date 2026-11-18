import { describe, expect, it } from "vitest";
import { basemapsFrom, baseStyle, FAILED_TILES, tileHosts, tileWatch, warmHosts, type Basemap } from "./basemap";
import { farmBounds } from "../farm/geometry";
import type { Farm } from "../farm/types";

describe("where the base maps come from is a setting (card 32)", () => {
  it("uses the keyless services, each with its own credit, when nothing is set", () => {
    const maps = basemapsFrom({});
    expect(maps.satellite!.tiles[0]).toContain("World_Imagery");
    expect(maps.satellite!.attribution).toContain("Esri");
    expect(maps.streets.tiles[0]).toContain("tile.openstreetmap.org");
    expect(maps.streets.attribution).toContain("OpenStreetMap");
  });

  it("takes another provider's address, and never shows the old provider's credit with it", () => {
    const maps = basemapsFrom({ VITE_SATELLITE_TILES: "https://tiles.example.org/sat/{z}/{x}/{y}.jpg?key=abc", VITE_SATELLITE_ATTRIBUTION: "© Example Imagery", VITE_STREET_TILES: "https://tiles.example.org/osm/{z}/{x}/{y}.png" });
    expect(maps.satellite).toMatchObject({ tiles: ["https://tiles.example.org/sat/{z}/{x}/{y}.jpg?key=abc"], attribution: "© Example Imagery" });
    expect(maps.streets.tiles).toEqual(["https://tiles.example.org/osm/{z}/{x}/{y}.png"]);
    expect(maps.streets.attribution).toBe("");
  });

  it("can run with no satellite photo, and ignores an address that is not a tile address", () => {
    const off = basemapsFrom({ VITE_SATELLITE_TILES: "off" });
    expect(Object.keys(off)).toEqual(["streets"]);
    const style = baseStyle("satellite", off);
    expect(Object.keys(style.sources)).toEqual(["streets"]);
    expect(style.layers.find((l) => l.id === "basemap-streets")).toMatchObject({ layout: { visibility: "visible" } });
    expect(basemapsFrom({ VITE_SATELLITE_TILES: "http://plain.example.org/{z}/{x}/{y}" }).satellite!.tiles[0]).toContain("World_Imagery");
    expect(basemapsFrom({ VITE_STREET_TILES: "https://example.org/no-placeholders" }).streets.tiles[0]).toContain("openstreetmap");
  });
});

describe("the map loads fast", () => {
  it("shows a tile the moment it arrives: no fade on either base map", () => {
    const style = baseStyle("satellite");
    for (const id of ["basemap-satellite", "basemap-streets"]) {
      expect(style.layers.find((l) => l.id === id)).toMatchObject({ paint: { "raster-fade-duration": 0 } });
    }
  });

  it("opens the connection to each tile host once, and fetches nothing", () => {
    const maps = basemapsFrom({});
    expect(tileHosts(maps)).toEqual(["https://server.arcgisonline.com", "https://tile.openstreetmap.org"]);
    const doc = document.implementation.createHTMLDocument("t");
    warmHosts(tileHosts(maps), doc);
    warmHosts(tileHosts(maps), doc);
    const links = [...doc.head.querySelectorAll("link")];
    expect(links.map((l) => [l.rel, l.getAttribute("href")])).toEqual([
      ["preconnect", "https://server.arcgisonline.com"],
      ["preconnect", "https://tile.openstreetmap.org"],
    ]);
  });

  it("opens on the saved farm: the box around all its fields, or nowhere in particular for a farm with none", () => {
    const square = (w: number, s: number): Farm["fields"][number]["geometry"] => ({ type: "Polygon", coordinates: [[[w, s], [w + 0.01, s], [w + 0.01, s + 0.01], [w, s + 0.01], [w, s]]] });
    const farm = { fields: [{ geometry: square(35.2, 0.5) }, { geometry: square(35.3, 0.48) }] } as unknown as Farm;
    const box = farmBounds(farm)!;
    expect(box[0]).toBeCloseTo(35.2, 6);
    expect(box[1]).toBeCloseTo(0.48, 6);
    expect(box[2]).toBeCloseTo(35.31, 6);
    expect(box[3]).toBeCloseTo(0.51, 6);
    expect(farmBounds({ fields: [] } as unknown as Farm)).toBeNull();
    expect(farmBounds(null)).toBeNull();
  });
});

describe("a base map that is being refused", () => {
  const run = (events: Array<"ok" | "bad">) => {
    const told: Basemap[] = [];
    const w = tileWatch((b) => told.push(b));
    for (const e of events) (e === "ok" ? w.arrived : w.failed)("satellite");
    return told;
  };

  it("is reported once, after several tiles fail and none arrives", () => {
    expect(run(Array(FAILED_TILES - 1).fill("bad"))).toEqual([]);
    expect(run(Array(30).fill("bad"))).toEqual(["satellite"]);
  });

  it("is still reported when a few old tiles arrive from the browser's own store", () => {
    expect(run(["ok", "ok", "ok", ...Array(25).fill("bad")])).toEqual(["satellite"]);
  });

  it("is not reported for a few failures among many arrivals (a weak connection)", () => {
    expect(run([...Array(20).fill("ok"), "bad", "bad", "bad", "bad", "bad"])).toEqual([]);
  });

  it("counts each base map on its own", () => {
    const told: Basemap[] = [];
    const w = tileWatch((b) => told.push(b));
    for (let i = 0; i < 10; i++) w.arrived("streets");
    for (let i = 0; i < 10; i++) w.failed("satellite");
    expect(told).toEqual(["satellite"]);
  });
});
