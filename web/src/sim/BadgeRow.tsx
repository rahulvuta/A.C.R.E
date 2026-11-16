import type { Reason, ScenarioBadge } from "./schema";
import { OriginLabel, ReasonText } from "./shared";
import "./sim.css";

export const badgeLabels = {
  best_profit: "Highest estimated margin of these plans", most_sustainable: "Most sustainable",
  lowest_weather_risk: "Lowest weather risk", best_for_priorities: "Best for your priorities",
} as const;
export interface BadgeRowProps {
  badges: ScenarioBadge[];
  scenarioId?: string;
  scenarioLabels?: Record<string, string>;
  notDecided?: Reason[];
}
export function BadgeRow({ badges, scenarioId, scenarioLabels = {}, notDecided = [] }: BadgeRowProps) {
  const visible = scenarioId ? badges.filter(b => b.scenario_id === scenarioId) : badges;
  return <div className="sim sim-badge-section"><div className="sim-badge-row" aria-label="Scenario badges">{visible.map((badge, index) => <article className="sim-badge" key={`${badge.badge}-${badge.scenario_id}-${index}`}><h4>{badgeLabels[badge.badge]}</h4>{!scenarioId && <p className="sim-badge-plan">{scenarioLabels[badge.scenario_id] ?? badge.scenario_id}</p>}<p>{badge.why || "Not available. The service did not explain this badge."}<OriginLabel origin={badge.origin} /></p></article>)}</div>{!visible.length && <p className="sim-muted">No badge was decided for {scenarioId ? "this plan" : "these plans"}.</p>}{notDecided.length > 0 && <div className="sim-not-decided"><h3>What could not be decided</h3><ul>{notDecided.map((reason, index) => <li key={index}>{typeof reason !== "string" && reason.badge && <strong>{badgeLabels[reason.badge as keyof typeof badgeLabels] ?? reason.badge}: </strong>}<ReasonText reason={reason} /></li>)}</ul></div>}</div>;
}
