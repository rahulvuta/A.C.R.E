import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FieldPlan } from "../../farm/types";
import { dayWords, plantingDay, SoilMoistureCard } from "./SoilMoisture";

const leg = (over: Partial<FieldPlan> = {}): FieldPlan => ({ plan_id: "season_1", label: "Season 1", previous_crop_id: "maize", prev_harvest: "09-10", winter: { kind: "none" }, next_crop_id: "dry_beans", next_plant: "03-15", ...over });
const YEARS = [2016, 2017, 2018, 2019, 2020].map((year, i) => ({ year, date: `${year}-03-15`, value: [0.291, 0.277, 0.355, 0.264, 0.366][i]! }));

describe("soil moisture at planting time (card 31)", () => {
  it("takes the planting day from the first season that has a planting", () => {
    expect(plantingDay([leg()])).toEqual({ monthDay: "03-15", cropId: "dry_beans" });
    expect(plantingDay([leg({ next_plant: "" })])).toBeNull();
    // a crop that stays in the ground is not planted each year
    expect(plantingDay([leg({ permanent: { sold: true } })])).toBeNull();
    expect(dayWords("03-15")).toMatch(/^15 /);
  });

  it("shows the middle year, every year, the driest and wettest, and what the number is", () => {
    render(<SoilMoistureCard years={YEARS} now={{ date: "2026-11-13", value: 0.31 }} monthDay="03-15" crop="dry beans" />);
    const card = screen.getByRole("region", { name: "Soil moisture at planting time" });
    expect(card).toHaveTextContent("29%"); // the middle of the five years
    expect(card).toHaveTextContent("Driest: 2019 (26%)");
    expect(card).toHaveTextContent("Wettest: 2020 (37%)");
    expect(card).toHaveTextContent(/Newest reading, 13 \S+ 2026: 31%/);
    expect(card).toHaveTextContent("when you plant dry beans");
    // said plainly: not the field's own soil, and no result changes
    expect(card).toHaveTextContent("not a reading from your soil");
    expect(card).toHaveTextContent("changes no result");
    expect(card).toHaveTextContent("NASA model");
    expect(screen.getByRole("img")).toHaveAccessibleName(/2016, 29%; 2017, 28%; 2018, 36%; 2019, 26%; 2020, 37%/);
  });

  it("says when a nearby day stood in, and shows nothing with fewer than three years", () => {
    const { container, rerender } = render(<SoilMoistureCard years={[...YEARS.slice(0, 4), { year: 2020, date: "2020-03-14", value: 0.3 }]} now={null} monthDay="03-15" crop="maize" />);
    expect(container).toHaveTextContent("the nearest day is used");
    expect(container).not.toHaveTextContent("Newest reading");
    rerender(<SoilMoistureCard years={YEARS.slice(0, 2)} now={null} monthDay="03-15" crop="maize" />);
    expect(container).toBeEmptyDOMElement();
  });
});
