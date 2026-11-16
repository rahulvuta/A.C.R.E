import type { FieldPlan, Origin } from "../farm/types";

/*
  The parts of the contract §11 simulate response (and §15 demo farm) the timeline reads.
  Field names are the backend's; D's adapter may hand these over unchanged.
*/
export interface Dist {
  p10?: number | null;
  median: number | null;
  p90?: number | null;
  unit?: string;
  currency?: string;
  origin?: Origin;
  includes_assumption?: string | null;
}
export interface Odds {
  probability: number | null;
  origin?: Origin;
}

export interface TimelineEntry {
  year: number;
  season: string;
  crop_sequence: string[];
  plan_id: string;
  /** Crops grown in the same field at the same time as the season's crop (card 21). */
  companions?: string[];
  /** "permanent": one crop that stays in the ground all year, so no bare spell is drawn. */
  ground?: string;
}

export interface YearResult {
  year: number;
  indicators?: {
    rain_on_bare_soil_mm?: Dist;
    living_cover_days?: Dist;
    dry_pre_plant?: Odds;
    heavy_rain_at_planting?: Odds;
    [k: string]: Dist | Odds | undefined;
  };
  money?: { revenue?: Dist; costs?: Dist; margin?: Dist } | null;
}

export interface ScenarioResult {
  scenario_id: string;
  label: string;
  status: string;
  timeline: TimelineEntry[];
  yearly: YearResult[];
  totals?: { margin_10y?: Dist; [k: string]: unknown };
  events?: Array<{ event: string; probability: number | null; text: string }>;
  money_status?: string;
}

/** A scenario for the timeline: the §11 result, plus the rotation it was simulated from (for dates). */
export interface TimelineScenario extends ScenarioResult {
  rotation?: FieldPlan[];
  is_baseline?: boolean;
}

/** Join a §11 response with its request so each scenario carries its rotation (the dates). */
export function withRotations(
  response: { scenarios: ScenarioResult[] },
  request?: { scenarios: Array<{ scenario_id: string; rotation: FieldPlan[]; is_baseline?: boolean }> } | null,
): TimelineScenario[] {
  const byId = new Map((request?.scenarios ?? []).map((s) => [s.scenario_id, s]));
  return response.scenarios.map((s) => ({ ...s, rotation: byId.get(s.scenario_id)?.rotation, is_baseline: byId.get(s.scenario_id)?.is_baseline ?? false }));
}
