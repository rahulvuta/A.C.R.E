/*
  Display names for crop ids from the world crop list, and the test for "does this place have
  a winter". Display only: the backend's crop library is the source of truth for what a crop is.
  Ids not listed here keep the readable name each screen already makes.
*/
export const WORLD_NAMES: Record<string, string> = {
  maize: "Maize",
  maize_second: "Maize, second season",
  rice: "Rice",
  rice_second: "Rice, second season",
  sorghum_second: "Sorghum, second season",
  pulses: "Pulses (beans, peas, lentils)",
  groundnut: "Groundnut (peanut)",
  winter_rapeseed: "Canola (rapeseed)",
  sweet_potato: "Sweet potato",
  sugarbeet: "Sugar beet",
  sugarcane: "Sugarcane",
  spring_wheat: "Spring wheat",
  winter_barley: "Winter barley",
  winter_oats: "Winter oats",
  winter_rye: "Winter rye",
};

const spaced = (id: string) => id.replace(/^other:/, "").replace(/_/g, " ");

/** A crop id as a name a grower would use: the world name when there is one, else the id with spaces. */
export const worldCropName = (id: string): string => WORLD_NAMES[id] ?? spaced(id);

/** A crop name as the service lists it, tidied for display ("Barley all" → "Barley"). */
export const tidyCropName = (name: string): string => {
  const s = name.replace(/\s+all$/i, "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name;
};

/** Text from the service with raw ids in it ("Harvest field_corn") read as words ("Harvest field corn"). */
export const plainIds = (text: string): string => text.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (id) => (WORLD_NAMES[id] ? WORLD_NAMES[id]!.toLowerCase() : spaced(id)));

/** Between the tropics there is no winter to plan around; the season words change there. */
export const hasWinter = (latitude: number | null | undefined): boolean => latitude == null || Math.abs(latitude) >= 23.5;
