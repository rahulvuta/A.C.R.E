import type { Origin } from "../farm/types";

/*
  One badge per `origin` value (card D3). The look is fixed per origin, so an AI row can never
  borrow the "published source" style: only `verified_source` gets the `ob-verified` class.
*/
export const ORIGIN_LABEL: Record<Origin, string> = {
  nasa_measured: "NASA measured",
  nasa_modeled: "NASA model",
  calculation: "Calculated",
  verified_source: "Published source",
  source_checked: "AI-found, quote checked",
  ai_suggested: "AI suggestion, not verified",
  grower: "You entered",
  assumed: "Guess",
  dataset_estimate: "Area estimate",
};

/** One plain sentence per origin, shown when the grower points at a label. */
export const ORIGIN_HELP: Record<Origin, string> = {
  nasa_measured: "Measured by NASA for the area around this field.",
  nasa_modeled: "From NASA's weather model for the area around this field (about 50 km across).",
  calculation: "Worked out by A.C.R.E from the numbers on this page.",
  verified_source: "From a published source that was checked by a person.",
  source_checked: "Found by AI in a published source; the quote was checked against the page.",
  ai_suggested: "Written by AI and not checked. Treat it as a suggestion.",
  grower: "A number you entered.",
  assumed: "A placeholder guess. Replace it with your own number when you can.",
  dataset_estimate: "A typical value for this area from a regional or world dataset, not for this farm.",
};

const ORIGIN_CLASS: Record<Origin, string> = {
  nasa_measured: "ob-nasa",
  nasa_modeled: "ob-nasa",
  calculation: "ob-calc",
  verified_source: "ob-verified",
  source_checked: "ob-ai",
  ai_suggested: "ob-ai",
  grower: "ob-grower",
  assumed: "ob-assumed",
  dataset_estimate: "ob-dataset",
};

export function originClass(o: Origin): string {
  return ORIGIN_CLASS[o] ?? "ob-ai";
}

export function OriginBadge({ origin, title }: { origin: Origin; title?: string }) {
  const label = ORIGIN_LABEL[origin] ?? ORIGIN_LABEL.ai_suggested;
  return (
    <span className={`ob ${originClass(origin)}`} data-origin={origin} title={title ?? ORIGIN_HELP[origin] ?? label}>
      {label}
    </span>
  );
}
