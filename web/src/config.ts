// Product-level constants. Change the name here and it changes everywhere.
export const APP_NAME = "A.C.R.E";
export const TASK_TITLE = "Compare winter crop plans";
export const TAGLINE = "Compare crop plans for your fields with an evidence-based 10-year outlook built from NASA weather.";
export const CHALLENGE_LABEL = "NASA Space Apps 2026 · A.C.R.E";

// The saved Union County sample, shaped like the backend API (backend docs/api/examples).
// Real generated output from the backend replaces these files with the same names.
export const SAMPLE_BASE = "./data/nasa";
export const SAMPLE_LOCATION_ID = "union_county_sample";

// The live backend, used only when the grower applies new dates. Set VITE_API_BASE at
// build time (for example the Render URL). Unset means saved sample only.
export const API_BASE: string | null = (import.meta.env.VITE_API_BASE as string | undefined) || null;

// Bounded waits so the UI never shows an endless spinner (playbook p.30, p.45).
export const LOAD_TIMEOUT_MS = 8000;
// A sleeping free-tier host can take a while to wake; past this the saved sample stays.
export const LIVE_TIMEOUT_MS = 20000;

// Fixture mode (no service, sample responses from src/api/fixtures/): `?fixtures=1`, or
// VITE_API_FIXTURES=1 at build time. Every screen that uses it says "Sample responses".
export const FIXTURE_MODE: boolean =
  !API_BASE &&
  ((import.meta.env.VITE_API_FIXTURES as string | undefined) === "1" ||
    (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("fixtures") === "1"));

// Bounded wait for the global endpoints (search, place, capabilities, farm analysis).
export const GLOBAL_TIMEOUT_MS = 20000;
