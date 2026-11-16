import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { FutureResponse } from "./api";
import type { Plan } from "./api";
import { nextJobs, ownCalendar, ThisSeasonList } from "./ThisSeason";

const ms = (date: string, label: string, kind: string) => ({ date, label, kind, origin: "grower" as const });
const result = {
  seasons: [
    { season: "2027", windows: [], milestones: [ms("2026-10-16", "Harvest barley", "harvest"), ms("2027-03-01", "Spring dryness window (the 30 days before planting)", "window"), ms("2027-03-31", "Plant maize", "plant"), ms("2027-03-31", "Starter fertilizer speeds early growth.", "check")] },
    { season: "2028", windows: [], milestones: [ms("2027-10-31", "Harvest field_corn", "harvest"), ms("2028-03-17", "Plant sorghum", "plant"), ms("2028-08-31", "Harvest sorghum", "harvest")] },
  ],
} as unknown as Pick<FutureResponse, "seasons">;

it("lists the next three jobs from the plan's own dates, skipping checks, windows and jobs already past", () => {
  expect(nextJobs(result, "2026-11-16").map((j) => `${j.date} ${j.label}`)).toEqual(["2027-03-31 Plant maize", "2027-10-31 Harvest field corn", "2028-03-17 Plant sorghum"]);
  expect(nextJobs(result, "2028-09-01")).toEqual([]);
});

it("opens on a short to-do list with dates in words, and is left out when nothing is ahead", () => {
  const { unmount } = render(<ThisSeasonList result={result} today="2026-11-16" />);
  const box = screen.getByRole("region", { name: "This season" });
  const jobs = within(box).getAllByRole("listitem");
  expect(jobs).toHaveLength(3);
  expect(jobs[0]!.textContent).toMatch(/Plant maize around 31 March 2027/);
  // Each job says where its date came from.
  expect(jobs[0]!.querySelector("[data-origin='grower']")).not.toBeNull();
  unmount();
  render(<ThisSeasonList result={result} today="2029-01-01" />);
  expect(screen.queryByRole("region", { name: "This season" })).toBeNull();
});

const leg = (previous: string, harvest: string, next: string, plant: string, winter: Record<string, unknown> = { kind: "none" }) => ({ plan_id: `${previous}-${next}`, previous_crop_id: previous, prev_harvest: harvest, winter, next_crop_id: next, next_plant: plant }) as unknown as Plan;

it("reads the next jobs from the grower's own dates when the service has no calendar for the plan", () => {
  // Kenya: maize harvested 31 October, dry beans planted 15 March, every year.
  const kenya = [leg("maize", "10-31", "dry_beans", "03-15")];
  expect(nextJobs(ownCalendar(kenya, "2027"), "2026-11-16").map((j) => `${j.date} ${j.label}`)).toEqual(["2027-03-15 Plant dry beans", "2027-10-31 Harvest maize", "2028-03-15 Plant dry beans"]);
  // North Carolina: corn harvested, rye sown and ended, corn planted; every job sits before the one after it.
  const nc = [leg("field_corn", "09-20", "field_corn", "04-15", { kind: "cover", crop_id: "cereal_rye", seed: "09-27", terminate: "04-08" })];
  expect(ownCalendar(nc, "2027", 1).seasons[0]!.milestones.map((m) => m.date).sort()).toEqual(["2026-09-20", "2026-09-27", "2027-04-08", "2027-04-15"]);
  // A two-season rotation takes its seasons in turn.
  const two = [leg("maize", "10-31", "sorghum", "03-17"), leg("sorghum", "08-31", "maize", "03-31")];
  expect(nextJobs(ownCalendar(two, "2027"), "2027-01-01", 4).map((j) => j.label)).toEqual(["Plant sorghum", "Harvest sorghum", "Plant maize", "Harvest maize"]);
  render(<ThisSeasonList result={{ seasons: [] }} own={{ plans: kenya, startSeason: "2027" }} today="2026-11-16" />);
  expect(within(screen.getByRole("region", { name: "This season" })).getAllByRole("listitem")[0]!.textContent).toMatch(/Plant dry beans around 15 March 2027/);
});

it("tops a one-season calendar up to three jobs from the plan's own repeating dates", () => {
  const india = [leg("rice", "10-20", "winter_wheat", "11-10")];
  const service = { seasons: [{ season: "2027", windows: [], milestones: [ms("2027-10-20", "Harvest rice", "harvest"), ms("2027-11-10", "Plant winter_wheat", "plant")] }] } as unknown as Pick<FutureResponse, "seasons">;
  render(<ThisSeasonList result={service} own={{ plans: india, startSeason: "2027" }} today="2026-11-16" />);
  const jobs = within(screen.getByRole("region", { name: "This season" })).getAllByRole("listitem").map((li) => li.textContent);
  expect(jobs).toHaveLength(3);
  expect(jobs[1]).toMatch(/Plant winter wheat around 10 November 2027/);
  expect(jobs[2]).toMatch(/Harvest rice around 20 October 2028/);
});

describe("the year's jobs for a crop that stays in the ground (card 21)", () => {
  it("lists its harvest and never a planting", () => {
    const coffee = { plan_id: "season_1", previous_crop_id: "coffee", prev_harvest: "10-31", winter: { kind: "none" }, next_crop_id: "coffee", next_plant: "10-31", permanent: { sold: true } } as unknown as Parameters<typeof ownCalendar>[0][number];
    const jobs = nextJobs(ownCalendar([coffee], "2027"), "2026-11-16");
    expect(jobs.map((j) => `${j.date} ${j.label}`)).toEqual(["2027-10-31 Harvest coffee", "2028-10-31 Harvest coffee", "2029-10-31 Harvest coffee"]);
    const grass = { ...coffee, previous_crop_id: "pasture_grass", next_crop_id: "pasture_grass", permanent: { sold: false } } as typeof coffee;
    expect(nextJobs(ownCalendar([grass], "2027"), "2026-11-16")).toEqual([]);
  });
});
