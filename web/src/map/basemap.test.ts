import { describe, expect, it } from "vitest";
import { basemapsFrom, baseStyle } from "./basemap";

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
