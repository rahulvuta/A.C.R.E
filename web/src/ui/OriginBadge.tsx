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
  assumed: "Assumed",
  dataset_estimate: "Dataset estimate",
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
    <span className={`ob ${originClass(origin)}`} data-origin={origin} title={title ?? label}>
      {label}
    </span>
  );
}
