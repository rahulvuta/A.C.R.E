import { describe, expect, it } from "vitest";
import { areaText, convert, getUnits, longDate, qtyText, rainText, rainToMm, resetUnitsForTests, setUnits, suggestUnits, tempToC, unitsForCountry } from "./units";

describe("units (card 15)", () => {
  it("starts from the field's country: metric almost everywhere, acres and inches in the US", () => {
    expect(unitsForCountry("KE")).toEqual({ area: "ha", rain: "mm", temp: "C", currency: "KES" });
    expect(unitsForCountry("IN")).toMatchObject({ area: "ha", currency: "INR" });
    expect(unitsForCountry("US")).toEqual({ area: "ac", rain: "in", temp: "F", currency: "USD" });
    expect(unitsForCountry("USA")).toMatchObject({ area: "ac" });
    // A country with no entry still gets metric, and no currency is guessed.
    expect(unitsForCountry("ZZ")).toEqual({ area: "ha", rain: "mm", temp: "C", currency: null });
  });

  it("follows the field's country until the grower chooses, then never changes for them", () => {
    resetUnitsForTests();
    suggestUnits("KE");
    expect(getUnits()).toMatchObject({ area: "ha", rain: "mm", currency: "KES", chosen: false });
    suggestUnits("US");
    expect(getUnits().area).toBe("ac");
    setUnits({ area: "ha" });
    suggestUnits("KE");
    suggestUnits("US");
    expect(getUnits()).toMatchObject({ area: "ha", rain: "in", chosen: true });
  });

  it("shows a Kenya field in hectares first", () => {
    resetUnitsForTests({ area: "ha" });
    expect(areaText(22_900)).toEqual({ main: "2.29 ha", other: "5.66 ac" });
    resetUnitsForTests({ area: "ac" });
    expect(areaText(22_900).main).toBe("5.66 ac");
  });

  it("converts only rain and temperature, and back again for what is typed", () => {
    resetUnitsForTests({ rain: "in", temp: "F" });
    expect(rainText(64)).toBe("2.5 in");
    expect(convert(20, "°C")).toMatchObject({ value: 68, unit: "°F" });
    expect(qtyText(254, "mm per season")).toBe("10 in per season");
    expect(qtyText(6.5, "pH")).toBe("6.5 pH");
    expect(rainToMm(1)).toBe(25.4);
    expect(tempToC(68)).toBe(20);
    resetUnitsForTests({ rain: "mm", temp: "C" });
    expect(rainText(64)).toBe("64 mm");
    expect(qtyText(254, "mm per season")).toBe("254 mm per season");
  });

  it("writes dates as day, month in words, year", () => {
    expect(longDate("2027-04-12")).toBe("12 April 2027");
    expect(longDate(null)).toBe("");
  });
});
