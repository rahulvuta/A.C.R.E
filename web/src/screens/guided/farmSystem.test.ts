import { describe, expect, it } from "vitest";
import type { FieldPlan } from "../../farm/types";
import { systemsOf } from "../../api/adapt";
import { cropsOf, planReady } from "./context";
import { asTwoCropsAYear, fitResults, leadInCrop, permanentSeason, returnSeason, withCompanion, yearLine, yearsOf } from "./farmSystem";

const season = (previous: string, next: string, winter: FieldPlan["winter"] = { kind: "none" }, id = "season_1"): FieldPlan => ({ plan_id: id, label: "Season", previous_crop_id: previous, prev_harvest: "10-31", winter, next_crop_id: next, next_plant: "03-15" });
const name = (id: string) => id.replaceAll("_", " ");

describe("the plan said back year by year (card 21)", () => {
  it("a single season with two different crops is the second crop every year, and says so", () => {
    const r = [season("maize", "dry_beans")];
    expect(yearLine(r, name)).toBe("Every year: dry beans.");
    // Maize was on the field before year 1 and is never planted again: the grower is asked, not guessed for.
    expect(leadInCrop(r)).toBe("maize");
  });

  it("adding the season that leads back makes the two crops take turns", () => {
    const r = [season("maize", "dry_beans")];
    const back = returnSeason(r)!;
    expect(back).toMatchObject({ plan_id: "season_2", previous_crop_id: "dry_beans", next_crop_id: "maize", prev_harvest: "", next_plant: "", winter: { kind: "none" } });
    const both = [...r, back];
    expect(leadInCrop(both)).toBeNull();
    expect(returnSeason(both)).toBeNull();
    expect(yearsOf(both).map((y) => y.crop)).toEqual(["dry_beans", "maize"]);
    expect(yearLine(both, name)).toBe("Year 1: dry beans. Year 2: maize. Then it starts again.");
  });

  it("a rotation that already leads back to its first crop raises no question", () => {
    expect(leadInCrop([season("field_corn", "soybean"), season("soybean", "field_corn", { kind: "none" }, "season_2")])).toBeNull();
    expect(leadInCrop([season("maize", "maize")])).toBeNull();
    // Not finished yet: nothing is said until every season has its crops.
    expect(leadInCrop([season("maize", "")])).toBeNull();
    expect(yearLine([season("maize", "")], name)).toBeNull();
  });

  it("two crops a year: the main crop on both sides and the second crop in between, both counted", () => {
    const two = asTwoCropsAYear(season("maize", "dry_beans"));
    expect(two).toMatchObject({ previous_crop_id: "maize", next_crop_id: "maize", prev_harvest: "10-31", next_plant: "", winter: { kind: "winter_grain", crop_id: "dry_beans", plant: "03-15", harvest: "" } });
    expect(leadInCrop([two])).toBeNull();
    expect(yearLine([two], name)).toBe("Every year: maize, then dry beans as a second crop.");
    // A plan that already has a harvested crop in between keeps it and its dates.
    const rice = season("rice", "rice", { kind: "winter_grain", crop_id: "wheat", plant: "11-10", harvest: "04-15" });
    expect(asTwoCropsAYear(rice)).toEqual(rice);
  });

  it("names a cover crop as a cover crop, never as a harvest", () => {
    expect(yearLine([season("soybean", "soybean", { kind: "cover", crop_id: "cereal_rye", seed: "10-01", terminate: "04-01" })], name)).toBe("Every year: soybean, with cereal rye as a cover crop before it.");
  });

  it("what the grower ticked is said on the results", () => {
    expect(fitResults(undefined)).toEqual([]);
    expect(fitResults(["irrigated", "unknown"])).toEqual(["“Planting time too dry” counts rain only. With irrigation, read it as the years you would have had to water before planting."]);
  });

  it("a crop grown together is named with the season's crop and sent with it", () => {
    const maize = season("maize", "maize");
    const mixed = withCompanion(maize, "dry_beans");
    expect(mixed.companions).toEqual(["dry_beans"]);
    expect(yearLine([mixed], name)).toBe("Every year: maize with dry beans grown together.");
    expect(systemsOf([mixed])).toEqual({ season_1: { companions: ["dry_beans"] } });
    expect(cropsOf([mixed])).toEqual(["maize", "dry_beans"]);
    // the season's own crop is not its companion, and removing the companion leaves an ordinary season
    expect(withCompanion(maize, "maize").companions).toBeUndefined();
    expect(withCompanion(mixed, null)).toEqual(maize);
    expect(systemsOf([maize])).toEqual({});
  });

  it("a crop that stays in the ground is one season with a harvest and no planting", () => {
    const coffee = permanentSeason("coffee", true, "10-31");
    expect(coffee).toMatchObject({ previous_crop_id: "coffee", next_crop_id: "coffee", prev_harvest: "10-31", next_plant: "10-31", winter: { kind: "none" }, permanent: { sold: true } });
    expect(yearLine([coffee], name)).toBe("Every year: coffee, which stays in the ground all year.");
    expect(leadInCrop([coffee])).toBeNull();
    expect(systemsOf([coffee])).toEqual({ season_1: { ground: "permanent", sold: true } });
    expect(planReady(coffee)).toBe(true);
    expect(planReady(permanentSeason("coffee", true))).toBe(false); // the harvest date is still to be picked
    // grazed pasture: nothing is sold, so no date and no price are asked for
    const grass = permanentSeason("pasture_grass", false);
    expect(planReady(grass)).toBe(true);
    expect(cropsOf([grass])).toEqual([]);
    expect(systemsOf([grass])).toEqual({ season_1: { ground: "permanent", sold: false } });
  });
});
