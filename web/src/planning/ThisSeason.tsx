import type { ReactNode } from "react";
import { fetchFuturePlan, type FutureRequest, type FutureResponse, type Plan } from "./api";
import { OriginBadge, usePlanningRequest } from "./shared";
import { plainIds, worldCropName } from "../ui/cropNames";
import { longDate } from "../ui/units";
import "./planning.css";

/*
  "This season" (card 12): the next three dated jobs from the plan's own calendar, so the plan
  opens on what to do next. The jobs and their dates are the ones the service returns for the
  grower's plan (harvest, seed, end a cover crop, plant); nothing is added or re-timed here.
  With no job still ahead, the box is left out.
*/
const JOB_KINDS = new Set(["harvest", "seed", "terminate", "plant"]);
export interface Job {
  date: string;
  label: string;
  origin: FutureResponse["seasons"][number]["milestones"][number]["origin"];
}

/** A job label as a sentence start: "Plant maize", "Harvest field corn". */
const jobLabel = (label: string) => {
  // The service's "Terminate" and "Seed" are the cover crop's end and sowing, said plainly.
  const s = plainIds(label).replace(/^Terminate (.+)$/, "End the $1 cover crop").replace(/^Seed (.+)$/, "Sow $1 as a cover crop");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
};

/** The next `count` jobs on or after `today` (YYYY-MM-DD), in date order, across every season of the plan. */
export function nextJobs(result: Pick<FutureResponse, "seasons">, today: string, count = 3): Job[] {
  const seen = new Set<string>();
  return result.seasons
    .flatMap((season) => season.milestones)
    .filter((m) => JOB_KINDS.has(String((m as { kind?: unknown }).kind ?? "")) && m.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((m) => {
      const key = `${m.date}|${m.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count)
    .map((m) => ({ date: m.date, label: jobLabel(m.label), origin: m.origin }));
}

export const todayIso = () => new Date().toLocaleDateString("en-CA");

const crop = (id: string) => worldCropName(id).toLowerCase();
/**
 * The same jobs read straight from the grower's own plan, for a plan the service has no
 * calendar for (a crop it does not list for the area, or no connection). Nothing is judged:
 * each season's planting falls in its season year, and the jobs before it (harvest of the
 * crop before, and any cover or second crop between) are placed at their latest date before
 * the job that follows, exactly as the plan orders them. The rotation repeats over `seasons` years.
 */
export function ownCalendar(plans: Plan[], startSeason: string, seasons = 10): Pick<FutureResponse, "seasons"> {
  const first = Number(startSeason);
  const milestones: Array<{ date: string; label: string; kind: string; origin: "grower" }> = [];
  if (!plans.length || !Number.isFinite(first)) return { seasons: [] };
  for (let t = 0; t < seasons; t++) {
    const leg = plans[t % plans.length]!;
    const w = leg.winter;
    // A crop that stays in the ground (trees, sugarcane, pasture) has no planting: its harvest, if it is sold, is the year's one job.
    const permanent = (leg as { permanent?: { sold?: boolean } }).permanent;
    if (permanent) {
      if (permanent.sold && /^\d{2}-\d{2}$/.test(leg.prev_harvest ?? "")) milestones.push({ date: `${first + t}-${leg.prev_harvest}`, label: `Harvest ${crop(leg.next_crop_id)}`, kind: "harvest", origin: "grower" });
      continue;
    }
    const steps: Array<{ mmdd: string | null | undefined; label: string; kind: string }> = [{ mmdd: leg.prev_harvest, label: `Harvest ${crop(leg.previous_crop_id)}`, kind: "harvest" }];
    if (w.kind === "cover" && w.crop_id) steps.push({ mmdd: w.seed, label: `Sow ${crop(w.crop_id)} as a cover crop`, kind: "seed" }, { mmdd: w.terminate, label: `End the ${crop(w.crop_id)} cover crop`, kind: "terminate" });
    if (w.kind === "winter_grain" && w.crop_id) steps.push({ mmdd: w.plant, label: `Plant ${crop(w.crop_id)}`, kind: "plant" }, { mmdd: w.harvest, label: `Harvest ${crop(w.crop_id)}`, kind: "harvest" });
    steps.push({ mmdd: leg.next_plant, label: `Plant ${crop(leg.next_crop_id)}`, kind: "plant" });
    // Walk back from the planting date, so every earlier job lands before the one after it.
    let year = first + t;
    let after = "12-31";
    for (const step of [...steps].reverse()) {
      if (!step.mmdd || !/^\d{2}-\d{2}$/.test(step.mmdd)) continue;
      if (step.mmdd > after) year -= 1;
      after = step.mmdd;
      milestones.push({ date: `${year}-${step.mmdd}`, label: step.label, kind: step.kind, origin: "grower" });
    }
  }
  return { seasons: [{ season: startSeason, milestones }] } as unknown as Pick<FutureResponse, "seasons">;
}

/** The next three jobs: from the service's calendar, topped up from the plan's own repeating dates. Also what the shared page lists. */
export function seasonJobs(result: Pick<FutureResponse, "seasons"> | null | undefined, own: { plans: Plan[]; startSeason: string } | undefined, today = todayIso()): Job[] {
  const fromService = result ? nextJobs(result, today) : [];
  // The service's calendar covers the seasons of the plan once; the plan repeats, so later jobs are read from the plan's own dates.
  const last = fromService[fromService.length - 1]?.date ?? "";
  const later = own && fromService.length < 3 ? nextJobs(ownCalendar(own.plans, own.startSeason), today, 12).filter((j) => j.date > last) : [];
  return [...fromService, ...later].slice(0, 3);
}

export function ThisSeasonList({ result, own, today = todayIso(), action }: { result?: Pick<FutureResponse, "seasons"> | null; /** The grower's own plan, used when the service returned no job for it. */ own?: { plans: Plan[]; startSeason: string }; today?: string; action?: ReactNode }) {
  const jobs = seasonJobs(result, own, today);
  if (!jobs.length) return null;
  return (
    <section className="db-card pl-this-season" aria-label="This season">
      <div className="db-card-head">
        <h2>This season</h2>
        {action}
      </div>
      <ol className="pl-jobs">
        {jobs.map((job, i) => (
          <li key={`${job.date}-${job.label}`}>
            <span className="pl-job-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="pl-job-text">
              <strong>{job.label}</strong> around <time dateTime={job.date}>{longDate(job.date)}</time>
            </span>
            <OriginBadge origin={job.origin} />
          </li>
        ))}
      </ol>
      <p className="pl-muted">Your next jobs, from the dates in your plan. They are planned dates, not a forecast.</p>
    </section>
  );
}

/** The same box for a screen that has not loaded the plan's calendar yet (the field page). */
export function ThisSeason({ location, plans, startSeason, action }: { location: { latitude: number; longitude: number }; plans: Plan[]; startSeason: string; action?: ReactNode }) {
  const request: FutureRequest = { location, plans, start_season: startSeason, seasons: plans.length };
  const { data, loading } = usePlanningRequest(JSON.stringify(request), (signal) => fetchFuturePlan({ ...request, edits: [] }, signal));
  if (loading)
    return (
      <p className="pl-muted" role="status">
        Working out your next jobs…
      </p>
    );
  // With no answer from the service the plan's own dates still give the next jobs.
  return <ThisSeasonList result={data ?? null} own={{ plans, startSeason }} action={action} />;
}
