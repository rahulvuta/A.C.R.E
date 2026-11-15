/*
  Public entry for the 10-year plan timeline (Agent C, card U4). Props are in docs/global/log-C.md.
*/
export { TenYearTimeline, type TenYearTimelineProps } from "./TenYearTimeline";
export { TimelineCompare, type TimelineCompareProps } from "./TimelineCompare";
export { withRotations, type TimelineScenario, type ScenarioResult, type TimelineEntry, type YearResult } from "./types";
export { buildRows } from "./schedule";
export { cropName } from "./crops";
export { MiniTimeline, planCrops } from "./MiniTimeline";
