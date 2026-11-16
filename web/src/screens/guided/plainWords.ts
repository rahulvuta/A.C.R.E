import type { Dist, ScenarioResult } from "../../api/simModel";
import { API_BASE } from "../../config";
import { rainText } from "../../ui/units";
import { isDist, money, num } from "./format";

/*
  The result in plain words, written by a model (card 26). The page sends only the figures it
  already shows, as the exact strings on screen, with on/off facts and crop ids: no field name,
  no place, no free text. The service checks the answer and returns it only if every number in
  it is one of the figures sent; otherwise nothing comes back and the three sentences above it,
  which are always shown, stand alone.
*/
export interface PlainFacts {
  facts: Record<string, string>;
  flags: string[];
  crops: string[];
}
const dist = (x: unknown): Dist | null => (isDist(x as Dist) ? (x as Dist) : null);

/** The figures of step 3's three sentences, written exactly as those sentences write them. */
export function plainFacts(s: ScenarioResult, crops: string[], twoCropsAYear = false): PlainFacts {
  const years = s.yearly.length || 10;
  const dry = dist(s.totals["dry_springs"]);
  const rain = dist(s.totals["rain_on_bare_soil_mm_per_year"]);
  const heavy = dist(s.totals["heavy_rain_days_on_bare_soil_per_year"]);
  const margin = dist(s.totals["margin_10y"]);
  const facts: Record<string, string> = { years: String(years) };
  const flags: string[] = [];
  const covered = s.timeline.length > 0 && s.timeline.every((t) => t.ground === "permanent");
  if (covered) flags.push("ground_covered_all_year");
  if (s.timeline.some((t) => t.companions?.length)) flags.push("crops_grown_together");
  if (!covered && dry?.median != null) {
    facts.dry_years = num(dry.median);
    if (dry.p10 != null && dry.p90 != null && dry.p10 !== dry.p90) {
      facts.dry_low = num(dry.p10);
      facts.dry_high = num(dry.p90);
    }
  }
  if (!covered && rain?.median != null) facts.rain_bare = rainText(rain.median);
  if (!covered && heavy?.median != null && heavy.median > 0) facts.heavy_days = num(heavy.median, null, 1);
  if (margin?.median != null) {
    facts.money_year = money(margin.median / years, margin.currency);
    facts.money_total = money(margin.median, margin.currency);
    const same = margin.p10 != null && margin.p90 != null && margin.p10 === margin.p90;
    if (margin.p10 != null && margin.p90 != null && !same) {
      facts.money_low = money(margin.p10, margin.currency);
      facts.money_high = money(margin.p90, margin.currency);
    }
    if (margin.includesAssumption) flags.push("money_uses_loss_estimate");
    else if (same) flags.push("money_flat");
  } else flags.push(s.nothingSold ? "nothing_sold" : "no_money");
  if (twoCropsAYear) flags.push("two_crops_a_year");
  return { facts, flags, crops: crops.filter((c) => /^[a-z][a-z0-9_]{1,39}$/.test(c)).slice(0, 8) };
}

const answers = new Map<string, Promise<string | null>>();
/** The checked explanation, or null when there is none (no service, no key, or the answer failed the check). Asked once per set of figures. */
export function plainWords(body: PlainFacts, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!API_BASE) return Promise.resolve(null);
  const key = JSON.stringify(body);
  let hit = answers.get(key);
  if (!hit) {
    hit = fetcher(`${API_BASE.replace(/\/$/, "")}/v1/explain`, { method: "POST", headers: { "Content-Type": "application/json" }, body: key })
      .then((r) => (r.ok ? (r.json() as Promise<{ status?: string; text?: unknown }>) : null))
      .then((doc) => (doc && doc.status === "complete" && typeof doc.text === "string" && doc.text.trim() ? doc.text.trim() : null))
      .catch(() => null);
    answers.set(key, hit);
    // A failure is not remembered, so the next visit can ask again.
    void hit.then((text) => {
      if (text === null) answers.delete(key);
    });
  }
  return hit;
}
export function resetPlainWordsForTests() {
  answers.clear();
}
