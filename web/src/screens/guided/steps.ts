import type { TermId } from "../../content/glossary";

/*
  The six steps of the guided flow (docs/global/simulator.md, card U1). Each has one clear
  question, one plain sentence and a glossary term behind "What does this mean?".
*/
export type StepId = "farm" | "now" | "simulate" | "try" | "compare" | "plan";
export interface StepDef {
  id: StepId;
  n: number;
  nav: string;
  question: string;
  sentence: string;
  term: TermId;
}
export const STEPS: readonly StepDef[] = [
  { id: "farm", n: 1, nav: "Your farm", question: "Where is your farm?", sentence: "Find it on the map and draw each field. Its size shows as soon as you finish a field.", term: "farm-field" },
  { id: "now", n: 2, nav: "What you do now", question: "What do you grow on this field now?", sentence: "A few short questions, one at a time: your crops, their dates, your equipment, then prices and losses. We fill in typical dates and published local prices for you to check.", term: "current-plan" },
  { id: "simulate", n: 3, nav: "Simulate current plan", question: "How would your current plan do over 10 years?", sentence: "Your plan is run through the next 10 years about 200 times, each time with this field's real past seasons in a different order.", term: "resampling" },
  { id: "try", n: 4, nav: "Try other plans", question: "What else could you try?", sentence: "Pick what matters most to you, then add suggested plans for this place or build your own. Up to 5 alongside your current plan.", term: "scenario" },
  { id: "compare", n: 5, nav: "Compare", question: "Which plan suits you best?", sentence: "Every plan side by side under the same weather seen at this field: money, dry planting seasons and rain on bare ground.", term: "comparison-badge" },
  { id: "plan", n: 6, nav: "Your 10-year plan", question: "What does your chosen plan look like, year by year?", sentence: "Your next jobs first, then the plan you chose as a dated 10-year timeline. Add a reading here whenever you measure one.", term: "ten-year-plan" },
];
export const stepIndex = (id: StepId) => STEPS.findIndex((s) => s.id === id);
