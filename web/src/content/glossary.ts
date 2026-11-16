/*
  Plain definitions for the terms the challenge asks teams to explain (card 6.6).
  Shown as tap-to-open terms on the planner and as a list on the Methods page.
*/

export type TermId =
  | "cover-crop"
  | "living-cover"
  | "residue"
  | "end-cover"
  | "double-crop"
  | "soil-wetness"
  | "driest-20"
  | "rank"
  | "regional-estimate"
  | "replay"
  | "extension"
  | "farm-field"
  | "current-plan"
  | "resampling"
  | "scenario"
  | "comparison-badge"
  | "ten-year-plan"
  | "band"
  | "margin"
  | "loss-assumption";

export const GLOSSARY: Record<TermId, { term: string; definition: string }> = {
  "cover-crop": {
    term: "Cover crop",
    definition: "A crop planted to protect and build the soil between the crops you sell, not to sell itself. Rye, oats, vetch, cowpea and mucuna are common ones.",
  },
  "living-cover": {
    term: "Living cover",
    definition: "Days when a planted crop is growing on the field. Here it is planned from seeding to ending dates, not measured.",
  },
  residue: {
    term: "Crop residue",
    definition: "Stalks and leaves left on the surface after harvest or after a cover crop ends. It still shields some soil, but it is not living cover.",
  },
  "end-cover": {
    term: "Ending the cover crop",
    definition: "Killing the cover crop before planting the next crop (often called termination). After it ends it stops using soil water.",
  },
  "double-crop": {
    term: "Two crops in one year",
    definition: "A second crop planted right after the first is harvested, so the land gives two harvests in one year: wheat after rice, beans after maize, or soybeans after a winter grain.",
  },
  "soil-wetness": {
    term: "Modeled soil wetness",
    definition:
      "NASA POWER's root-zone soil wetness, a 0 to 1 value from a weather model (MERRA-2) for the area around the grid point. 0 is dry, 1 is saturated. It is not a reading from your field.",
  },
  "driest-20": {
    term: "Driest 20%",
    definition: "Planting seasons whose rain in the 30 days before planting was among the driest fifth of all the years on record here. A label for comparing past years, not a drought declaration.",
  },
  rank: {
    term: "Rank",
    definition: "Where one year's rain in the 30 days before planting falls among all the years on record for the same dates. 1 is the driest.",
  },
  "regional-estimate": {
    term: "Regional estimate",
    definition: "NASA POWER values describe a grid cell roughly 50 km across, not one farm. Local storms can make a field wetter or drier than the estimate.",
  },
  replay: {
    term: "Historical replay",
    definition: "Running this year's planned dates against the weather of a past year. It shows how a plan would have fared in that year; it cannot say what the next season will bring.",
  },
  extension: {
    term: "Local farm adviser",
    definition: "Someone near you whose job is to help growers with crop decisions: an extension officer, a co-op or farmer-group agronomist, or the district agriculture office. Take your plan to them before you change what you grow.",
  },
  "farm-field": {
    term: "Fields and their size",
    definition: "Each field you draw keeps its own plan. The size is measured from the outline you draw, in hectares or acres as you choose under Units; the service measures it again for any money result. Your outlines stay in this browser.",
  },
  "current-plan": {
    term: "Your current plan",
    definition: "The crops and dates you use now, as a rotation of one to ten seasons that repeats. It is the baseline every other plan is compared with.",
  },
  resampling: {
    term: "How the outlook is built",
    definition: "Your plan is carried through the next 10 years about 200 times. Each time, the field's real past seasons (1981 to 2025, from NASA weather data) are put in a different order, and rain is adjusted when the field's own record shows a clear trend. It shows what to plan for under the conditions seen here. It cannot say what any single year will bring.",
  },
  scenario: {
    term: "Scenario",
    definition: "Another plan for the same field, such as adding a cover crop or a second crop. Each one is run through the same simulated years as your current plan, so they can be compared fairly.",
  },
  "comparison-badge": {
    term: "Badges",
    definition: "Highest estimated margin of these plans, most sustainable, lowest weather risk and best for your priorities. Each is the best of the plans you compared (not of every possible plan), given these numbers and the conditions seen at this field; a badge is left out when it cannot be decided fairly.",
  },
  "ten-year-plan": {
    term: "Your 10-year plan",
    definition: "The plan you chose, laid out year by year with its crops, key dates, decision deadlines and a backup. Dates come from your entries or published guidance, each with its source.",
  },
  band: {
    term: "Typical range",
    definition: "The middle result across all the simulated years, with the bad-year end and the good-year end. Eight in ten simulated years fall inside the range.",
  },
  margin: {
    term: "Margin",
    definition: "Revenue minus costs, from your own prices, yields and costs or from sourced regional figures (FAOSTAT, national statistics, university surveys), including AI-found figures whose quote was checked on the cited page (labelled \"AI-found, quote checked\"). A crop with none has no money result.",
  },
  "loss-assumption": {
    term: "Your loss estimate",
    definition: "Your own guess of how much of the harvest you lose when planting time is too dry or when heavy rain falls on bare ground. It is the only way weather turns into money here, and results that use it are labelled as your estimate.",
  },
};
