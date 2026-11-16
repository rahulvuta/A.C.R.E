import { describe, expect, it } from "vitest";
import { fromTyped, inWords, parseLocalUnit, sentWords, toService } from "./localUnits";

describe("local selling units (card 16)", () => {
  it("turns bags, quintals and kilos into the tonnes the service takes", () => {
    // 18 bags of 90 kg per acre is 1.62 tonnes per acre.
    expect(toService({ value: 18, unit: "bags/acre", bag_kg: 90 })).toEqual({ value: 1.62, unit: "t/acre" });
    // The same unit however the grower writes "acre".
    expect(toService({ value: 18, unit: "bags/ac", bag_kg: 90 })).toEqual({ value: 1.62, unit: "t/acre" });
    expect(toService({ value: 18, unit: "Bags / Acres", bag_kg: 90 })).toEqual({ value: 1.62, unit: "t/acre" });
    expect(toService({ value: 45, unit: "q/ha", bag_kg: null })).toEqual({ value: 4.5, unit: "t/ha" });
    expect(toService({ value: 800, unit: "kg/acre", bag_kg: null })).toEqual({ value: 0.8, unit: "t/acre" });
    // A price per bag of 90 kg, and per quintal, as a price per tonne.
    expect(toService({ value: 3600, unit: "KES/bag", bag_kg: 90 })).toEqual({ value: 40000, unit: "KES/t" });
    expect(toService({ value: 2300, unit: "inr/q", bag_kg: null })).toEqual({ value: 23000, unit: "INR/t" });
  });

  it("gives no number for a bag until the grower says how heavy it is", () => {
    expect(toService({ value: 18, unit: "bags/acre", bag_kg: null })).toEqual({ value: null, unit: "t/acre" });
    expect(fromTyped(18, "bags/acre", null)).toMatchObject({ value: null, unit: "t/acre", local: { value: 18, unit: "bags/acre", bag_kg: null } });
  });

  it("leaves the units the service already takes alone", () => {
    for (const unit of ["t/ha", "kg/ha", "bu/acre", "USD/t", "KES/kg", ""]) expect(parseLocalUnit(unit)).toBeNull();
    expect(fromTyped(1.8, "t/ha", null)).toEqual({ value: 1.8, unit: "t/ha", origin: "grower" });
  });

  it("comes back in the grower's own words, with what was sent beside it", () => {
    const y = fromTyped(18, "bags/acre", 90);
    expect(inWords(y)).toBe("18 bags of 90 kg per acre");
    expect(sentWords(y)).toBe("1.62 tonnes per acre");
    const p = fromTyped(3600, "KES/bag", 90);
    expect(inWords(p)).toBe("3,600 KES per bag of 90 kg");
    expect(sentWords(p)).toBe("40,000 KES per tonne");
    expect(inWords(fromTyped(45, "q/ha", null))).toBe("45 quintals per hectare");
  });

  it("a price found per bag of known weight is taken up as the grower's own bag price (card 24)", async () => {
    const { suggestionQuantity } = await import("./EconomicsEditor");
    // Found on a live Kenya lookup: "KSh 3,443 per 90-kg bag".
    const bag = suggestionQuantity({ value: 3443, unit: "KES/90kg" });
    expect(bag).toMatchObject({ unit: "KES/t", origin: "grower", local: { value: 3443, unit: "KES/bag", bag_kg: 90 } });
    expect(bag.value).toBeCloseTo(38255.6, 1);
    expect(suggestionQuantity({ value: 2275, unit: "INR/q" })).toMatchObject({ value: 22750, unit: "INR/t", local: { value: 2275, unit: "INR/q" } });
    // Any other unit is taken exactly as found.
    expect(suggestionQuantity({ value: 437.4, unit: "USD/t" })).toEqual({ value: 437.4, unit: "USD/t", origin: "grower" });
  });
});
