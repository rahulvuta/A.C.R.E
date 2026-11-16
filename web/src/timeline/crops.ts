/*
  Plain names and timeline colours for crop ids. Display only: the backend's crop library
  (§13) is the source of truth for what a crop is; unknown ids get a readable name and a
  neutral colour. Colours are illustration fills; text on them uses the kit's ink.
*/
export type BandKind = "cash" | "cover" | "fallow";

const NAMES: Record<string, string> = {
  field_corn: "Corn",
  corn: "Corn",
  sweet_corn: "Sweet corn",
  soybean: "Soybean",
  wheat: "Wheat",
  winter_wheat: "Winter wheat",
  barley: "Barley",
  oats: "Oats",
  sorghum: "Sorghum",
  cotton: "Cotton",
  peanut: "Peanut",
  sunflower: "Sunflower",
  cereal_rye: "Cereal rye",
  crimson_clover: "Crimson clover",
  hairy_vetch: "Hairy vetch",
  radish: "Radish",
  oat_cover: "Oats (cover)",
};

const FILL: Record<string, string> = {
  field_corn: "#EBCB6B",
  corn: "#EBCB6B",
  soybean: "#A9C97A",
  wheat: "#D8B26E",
  winter_wheat: "#D8B26E",
  barley: "#D9C08A",
  sorghum: "#D49A6A",
  cotton: "#E6E1D3",
  peanut: "#C9A27A",
};
export const COVER_FILL = "#4FAE7E";
export const FALLOW_FILL = "#ECEEF0";
const CASH_DEFAULT = "#C8D3A8";

export function cropName(id: string | null | undefined): string {
  if (!id) return "No crop";
  if (NAMES[id]) return NAMES[id]!;
  const s = id.replace(/^other:/, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function bandFill(kind: BandKind, crop: string | null): string {
  if (kind === "fallow") return FALLOW_FILL;
  if (kind === "cover") return COVER_FILL;
  return (crop && FILL[crop]) || CASH_DEFAULT;
}
