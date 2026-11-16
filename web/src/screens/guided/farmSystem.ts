import type { FieldPlan } from "../../farm/types";

/*
  What kind of farm the plan describes, said back in plain words (card 21).

  The service works with one field and one crop after another: each season of a rotation is the
  crop harvested before it, what is on the field in between, and the crop planted next. The
  rotation then repeats. Two things follow that a grower cannot be expected to guess:

  - A single season "maize, then dry beans" repeats as dry beans every year. Maize is only what
    stood on the field before the first year. If the two crops take turns, the rotation needs a
    second season that leads back to maize.
  - A second crop harvested in the same year (two rainy seasons, or a winter crop) goes in the
    middle box, and both crops are counted.
  - A crop grown together with the season's crop is named on the season (`companions`) and is
    counted in the money; a crop that stays in the ground for years (`permanent`) is one season
    with no planting, no bare ground and its own yearly harvest.

  Nothing here changes a result: these helpers only describe the rotation, or build the season
  the grower asks for. What the plan still cannot say (irrigation) is listed in FIT_NOTES and
  shown on the results.
*/

/** One year of the repeating plan: the crop planted that year, and what comes before it. */
export interface PlanYear {
  crop: string;
  before: { kind: "cover" | "winter_grain"; crop: string } | null;
}

export function yearsOf(rotation: FieldPlan[]): PlanYear[] {
  return rotation
    .filter((p) => p.next_crop_id)
    .map((p) => ({ crop: p.next_crop_id, before: p.winter.kind !== "none" && p.winter.crop_id ? { kind: p.winter.kind, crop: p.winter.crop_id } : null }));
}

/**
 * The first season's "crop before" when the plan never grows it again: it was on the field
 * before year 1 and then drops out. Null when the rotation leads back to it, or is not complete.
 */
export function leadInCrop(rotation: FieldPlan[]): string | null {
  const first = rotation[0];
  const last = rotation[rotation.length - 1];
  if (!first?.previous_crop_id || !last?.next_crop_id) return null;
  if (rotation.some((p) => !p.previous_crop_id || !p.next_crop_id)) return null;
  return rotation.some((p) => p.next_crop_id === first.previous_crop_id) ? null : first.previous_crop_id;
}

/** The season that leads back to the first crop: from the last crop planted to the crop the plan started with. Dates are asked next. */
export function returnSeason(rotation: FieldPlan[]): FieldPlan | null {
  const back = leadInCrop(rotation);
  const last = rotation[rotation.length - 1];
  if (!back || !last) return null;
  const taken = rotation.map((p) => p.plan_id);
  let n = rotation.length + 1;
  while (taken.includes(`season_${n}`)) n += 1;
  return { plan_id: `season_${n}`, label: `Season ${rotation.length + 1}`, previous_crop_id: last.next_crop_id, prev_harvest: "", winter: { kind: "none" }, next_crop_id: back, next_plant: "" };
}

/**
 * Two crops every year on one field: the main crop is both the crop before and the crop after,
 * and the second crop is the harvested crop in between. Keeps every crop and date that still applies.
 */
export function asTwoCropsAYear(season: FieldPlan): FieldPlan {
  const main = season.previous_crop_id || season.next_crop_id;
  const was = season.winter.kind === "winter_grain" ? season.winter : null;
  // "Maize, then beans" entered as two crops in a row becomes maize with beans as the second crop.
  const moved = !was && season.next_crop_id && season.next_crop_id !== main;
  return {
    ...season,
    previous_crop_id: main,
    next_crop_id: main,
    next_plant: season.next_crop_id === main ? season.next_plant : "",
    winter: was ?? { kind: "winter_grain", crop_id: moved ? season.next_crop_id : "", plant: moved ? season.next_plant : "", harvest: "" },
  };
}

/** The repeating plan in one sentence. `name` turns a crop id into the name the grower sees. */
export function yearLine(rotation: FieldPlan[], name: (id: string) => string): string | null {
  const years = yearsOf(rotation);
  if (!years.length || years.length !== rotation.length) return null;
  const crop = (i: number) => {
    const p = rotation[i]!;
    const mates = p.permanent ? [] : (p.companions ?? []).filter(Boolean);
    return mates.length ? `${name(p.next_crop_id)} with ${mates.map(name).join(" and ")} grown together` : name(p.next_crop_id);
  };
  const one = (y: PlanYear, i: number, mainFirst: boolean) => {
    if (rotation[i]!.permanent) return `${name(y.crop)}, which stays in the ground all year`;
    if (!y.before) return crop(i);
    if (y.before.kind === "cover") return `${crop(i)}, with ${name(y.before.crop)} as a cover crop before it`;
    return mainFirst ? `${crop(i)}, then ${name(y.before.crop)} as a second crop` : `${name(y.before.crop)}, then ${crop(i)}`;
  };
  if (years.length === 1) return `Every year: ${one(years[0]!, 0, rotation[0]!.previous_crop_id === rotation[0]!.next_crop_id)}.`;
  return `${years.map((y, i) => `Year ${i + 1}: ${one(y, i, false)}.`).join(" ")} Then it starts again.`;
}

/** A field under one crop that stays in the ground: trees, sugarcane, tea, pasture. Its one date is the harvest; nothing is planted. */
export function permanentSeason(cropId: string, sold: boolean, harvest = ""): FieldPlan {
  // Ground nothing is sold from has no date to ask for; the service still needs one, so a fixed one is kept.
  const date = sold ? harvest : "12-31";
  return { plan_id: "season_1", label: "Season 1", previous_crop_id: cropId, prev_harvest: date, winter: { kind: "none" }, next_crop_id: cropId, next_plant: date, permanent: { sold } };
}

/** The season with a crop grown together with its own (or with none, when `cropId` is empty). */
export function withCompanion(season: FieldPlan, cropId: string | null): FieldPlan {
  const { companions: _old, ...rest } = season;
  return cropId && cropId !== season.next_crop_id ? { ...rest, companions: [cropId] } : rest;
}

/** Kinds of farming the plan cannot hold yet. The grower ticks the ones that are theirs; the results then say what is left out. */
export const FIT_NOTES = [
  {
    id: "irrigated",
    title: "I water the field when it does not rain",
    example: "Canal, furrow, pump, sprinkler or drip; flooded rice.",
    enter: "Enter your crops as usual. “Planting time too dry” counts rain only, so read it as the years you would have had to water before planting.",
    result: "“Planting time too dry” counts rain only. With irrigation, read it as the years you would have had to water before planting.",
  },
] as const;
export type FitNoteId = (typeof FIT_NOTES)[number]["id"];
export const fitResults = (ids: readonly string[] | undefined): string[] => FIT_NOTES.filter((n) => ids?.includes(n.id)).map((n) => n.result);
