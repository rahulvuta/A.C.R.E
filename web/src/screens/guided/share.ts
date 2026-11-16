import type { CropOverride } from "../../api/simModel";
import type { FieldPlan } from "../../farm/types";
import { longDate } from "../../ui/units";

/*
  What a grower hands on (card 22): the plan in one line, the next jobs, the three result
  sentences and where the numbers came from. The same content makes the printed page and the
  text sent by message. It is built from the field's name and size and the plan: no outline,
  no coordinates and no place go in, so nothing shared can locate the field.
*/
export interface ShareInput {
  fieldName: string;
  /** "3.4 ha": the size in the grower's unit. */
  size: string | null;
  /** "Every year: maize, then dry beans as a second crop." */
  planLine: string;
  jobs: Array<{ date: string; label: string }>;
  /** The three sentences of step 3, exactly as shown there. */
  sentences: string[];
  rotation: FieldPlan[];
  overrides: Record<string, CropOverride>;
  crops: string[];
  sourceYears: string | null;
  runs: number | null;
  /** What the grower said the plan leaves out (card 21). */
  cautions: string[];
  /** YYYY-MM-DD. */
  today: string;
}
export interface Share {
  title: string;
  /** The grower's own name for the field, kept apart so the page can mark it "do not translate": it is never sent anywhere. */
  fieldName: string;
  size: string | null;
  planLine: string;
  jobs: string[];
  sentences: string[];
  sources: string[];
  cautions: string[];
  foot: string[];
}

const hasOwn = (o: CropOverride | undefined) => Boolean(o && (o.price || o.yield || o.costPerArea || o.costItems?.length || o.priceCases?.typical));

export function buildShare(i: ShareInput): Share {
  const own = i.crops.filter((c) => hasOwn(i.overrides[c])).length;
  const money = !i.crops.length ? null : own === i.crops.length ? "Prices, yields and costs: the grower's own numbers." : own > 0 ? "Prices, yields and costs: the grower's own numbers for some crops, published figures for the rest." : "Prices, yields and costs: published figures for the area, not the grower's own.";
  const origins = i.rotation.map((p) => p.origins?.dates).filter(Boolean);
  const dates = origins.length && origins.every((o) => o === "grower") ? "Planting and harvest dates: the grower's own." : "Planting and harvest dates: the grower's where entered, typical dates for the area for the rest.";
  return {
    title: `10-year plan for ${i.fieldName}${i.size ? ` (${i.size})` : ""}`,
    fieldName: i.fieldName,
    size: i.size,
    planLine: i.planLine,
    jobs: i.jobs.map((j) => `${j.label} around ${longDate(j.date)}`),
    sentences: i.sentences,
    sources: [
      `Weather: NASA records${i.sourceYears ? ` for ${i.sourceYears}` : ""}, for the area around the field (about 50 km across), not measured on the field.`,
      ...(money ? [money] : []),
      dates,
      `How: the plan was run through the next 10 years${i.runs ? ` about ${i.runs} times` : ""}, each time with the field's real past seasons in a different order.`,
    ],
    cautions: i.cautions,
    foot: ["Planned dates and past weather. It shows what to plan for; it cannot say what any single year will bring.", "Check it with your local farm adviser or co-op before you change what you grow.", `Made with A.C.R.E on ${longDate(i.today)}.`],
  };
}

/** The share as a short message: plain lines, no tables, so it pastes cleanly into any chat. */
export function shareText(s: Share): string {
  const block = (head: string, lines: string[], mark: (i: number) => string) => (lines.length ? [head, ...lines.map((l, i) => `${mark(i)} ${l}`), ""] : []);
  return [s.title, s.planLine, "", ...block("This season", s.jobs, (i) => `${i + 1}.`), ...block("What the past weather says", s.sentences, () => "-"), ...block("Where the numbers come from", s.sources, () => "-"), ...block("Not in these results", s.cautions, () => "-"), ...s.foot]
    .join("\n")
    .trim();
}
