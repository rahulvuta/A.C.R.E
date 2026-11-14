#!/usr/bin/env node
/*
  Builds the contract fixtures in src/api/fixtures/ (Agent D, card D1).

  Every file is a synthetic response shaped from docs/global/contract.md, labelled with a
  top-level `_fixture` note. The Pergamino seasons are made up (a seeded random series); the
  Union County field result reuses the saved real NASA sample entry for `soy_corn__rye` from
  public/data/nasa/compare.json. Field polygons are invented shapes, not anyone's farm.

  Areas use @turf/area's own formula (spherical excess, radius 6378137 m), so C2's check
  "within 0.1% of the fixture's area_ha" compares like with like.

  Run: node scripts/make-fixtures.mjs
*/
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src/api/fixtures");
mkdirSync(out, { recursive: true });

const NOTE = "Synthetic fixture built from docs/global/contract.md (Agent D). Not real backend output; geometry is invented.";
const write = (name, body) => writeFileSync(join(out, `${name}.json`), JSON.stringify({ _fixture: NOTE, ...body }, null, 2) + "\n");

// ------------------------------------------------------------------ geometry (turf's ringArea)
const R = 6378137;
function ringArea(coords) {
  const n = coords.length - 1;
  if (n <= 2) return 0;
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = coords[i];
    const middle = coords[i + 1 === n ? 0 : i + 1];
    const upper = coords[i + 2 >= n ? (i + 2) % n : i + 2];
    total += (upper[0] * rad - lower[0] * rad) * Math.sin(middle[1] * rad);
  }
  return (total * R * R) / 2;
}
const polyArea = (rings) => rings.reduce((a, r, i) => (i === 0 ? a + Math.abs(ringArea(r)) : a - Math.abs(ringArea(r))), 0);
const geomArea = (g) => (g.type === "Polygon" ? polyArea(g.coordinates) : g.coordinates.reduce((a, p) => a + polyArea(p), 0));
const r2 = (x) => Math.round(x * 100) / 100;
const ha = (g) => r2(geomArea(g) / 10000);
const ac = (g) => r2(geomArea(g) / 4046.8564224);
const close = (ring) => [...ring, ring[0]];

const POLYGONS = {
  // Pergamino, AR (cell lat-34.00_lon-60.625). The contract's own square.
  pergamino_square: { type: "Polygon", coordinates: [close([[-60.58, -33.88], [-60.57, -33.88], [-60.57, -33.89], [-60.58, -33.89]])] },
  pergamino_l: {
    type: "Polygon",
    coordinates: [close([[-60.6, -33.9], [-60.585, -33.9], [-60.585, -33.905], [-60.594, -33.905], [-60.594, -33.915], [-60.6, -33.915]])],
  },
  pergamino_holed: {
    type: "Polygon",
    coordinates: [
      close([[-60.56, -33.92], [-60.545, -33.92], [-60.545, -33.932], [-60.56, -33.932]]),
      close([[-60.555, -33.924], [-60.55, -33.924], [-60.55, -33.928], [-60.555, -33.928]]),
    ],
  },
  // Another cell east of Pergamino (lat-34.00_lon-60.000).
  pergamino_east: { type: "Polygon", coordinates: [close([[-60.26, -33.9], [-60.25, -33.9], [-60.25, -33.908], [-60.26, -33.908]])] },
  // Union County, NC (cell lat35.00_lon-80.625): two parcels in one field.
  union_parcels: {
    type: "MultiPolygon",
    coordinates: [
      [close([[-80.56, 34.985], [-80.552, 34.985], [-80.552, 34.979], [-80.56, 34.979]])],
      [close([[-80.549, 34.983], [-80.545, 34.983], [-80.545, 34.978], [-80.549, 34.978]])],
    ],
  },
  // Self-intersecting: must be rejected (C2, A3).
  bowtie: { type: "Polygon", coordinates: [close([[-60.58, -33.95], [-60.57, -33.96], [-60.57, -33.95], [-60.58, -33.96]])] },
};

writeFileSync(
  join(out, "polygons.json"),
  JSON.stringify(
    {
      _fixture: NOTE,
      polygons: Object.fromEntries(
        Object.entries(POLYGONS).map(([k, g]) => [k, { geometry: g, area_ha: k === "bowtie" ? null : ha(g), valid: k !== "bowtie" }]),
      ),
    },
    null,
    2,
  ) + "\n",
);

// ------------------------------------------------------------------ shared pieces
const meta = (id) => ({ plan_version: "fixture", catalog_version: "v3:fixture", snapshot_hash: "fixture-0000", request_id: `fx_${id}` });
const CELL_PERG = "lat-34.00_lon-60.625";
const CELL_PERG_E = "lat-34.00_lon-60.000";
const CELL_UNION = "lat35.00_lon-80.625";
const cellBlock = (lat, lon) => ({ center: { latitude: lat, longitude: lon }, size_deg: [0.5, 0.625], note: "One NASA POWER weather series covers this whole cell." });

// ------------------------------------------------------------------ §2 weather
const coverage = { first_date: "1981-01-01", last_date: "2026-11-10", complete_pre_plant_windows: null, complete_years: 45, missing_days: { PRECTOTCORR: 0 }, status: "complete" };
write("weather-ready", {
  meta: meta("weather_ready"), cell_id: CELL_PERG, job_status: "ready", status: "complete", reason: null, reason_text: null,
  source: "fetched", snapshot_hash: "fixture-perg-0001", retrieved_at: "2026-11-14T15:02:11Z", cell: cellBlock(-34.0, -60.625), coverage,
});
write("weather-pending", {
  meta: meta("weather_pending"), cell_id: CELL_PERG_E, job_status: "pending", status: "unknown", reason: null, reason_text: null,
  poll: `/v1/weather/${CELL_PERG_E}`, source: null, snapshot_hash: null, retrieved_at: null, cell: cellBlock(-34.0, -60.0), coverage: null,
});
write("weather-offline", {
  meta: meta("weather_offline"), cell_id: CELL_PERG_E, job_status: "failed", status: "unavailable", reason: "offline_no_snapshot",
  reason_text: "This weather cell is not stored and the service is offline, so its history can't be fetched.",
  source: null, snapshot_hash: null, retrieved_at: null, cell: cellBlock(-34.0, -60.0), coverage: null,
});
write("weather-union", {
  meta: meta("weather_union"), cell_id: CELL_UNION, job_status: "ready", status: "complete", reason: null, reason_text: null,
  source: "committed", snapshot_hash: "5ce131cfcd1f07d3738ecb9afaec6c3ef6a4764b6a3528bdd2b64debe7ba5f4e", retrieved_at: "2026-11-13T03:24:40Z",
  cell: cellBlock(35.0, -80.625), coverage: { ...coverage, last_date: "2025-06-30" },
});

// ------------------------------------------------------------------ §3 geo
write("geo-search-pergamino", {
  meta: meta("search_perg"), query_kind: "text",
  results: [
    { label: "Pergamino, Buenos Aires, Argentina", latitude: -33.89, longitude: -60.57, bbox: [-60.65, -33.95, -60.5, -33.83], kind: "city", source: "nominatim" },
    { label: "Partido de Pergamino, Buenos Aires, Argentina", latitude: -33.8, longitude: -60.6, bbox: [-60.95, -34.15, -60.2, -33.45], kind: "admin", source: "nominatim" },
  ],
});
write("geo-search-coordinates", {
  meta: meta("search_coords"), query_kind: "coordinates",
  results: [{ label: "35.10, -80.50", latitude: 35.1, longitude: -80.5, bbox: null, kind: "coordinates", source: "parsed" }],
});
write("geo-search-empty", { meta: meta("search_empty"), query_kind: "text", results: [] });
write("geo-reverse-pergamino", {
  meta: meta("reverse_perg"), status: "complete",
  place: { display: "Pergamino, Buenos Aires, Argentina", country: "AR", country_name: "Argentina", admin1: "AR-B", admin1_name: "Buenos Aires", admin2_name: "Pergamino" },
  hemisphere: "south", on_land: true,
  climate: { koppen: "Cfa", label: "Humid subtropical", resolution_km: 5, source: "Beck et al. 2023, Koppen-Geiger 1991-2020", origin: "dataset_estimate" },
  cell_id: CELL_PERG, region_keys: ["AR-B", "AR", "koppen:Cfa"], nc_region: null,
});
write("geo-reverse-union", {
  meta: meta("reverse_union"), status: "complete",
  place: { display: "Union County, North Carolina, United States", country: "US", country_name: "United States", admin1: "US-NC", admin1_name: "North Carolina", admin2_name: "Union County" },
  hemisphere: "north", on_land: true,
  climate: { koppen: "Cfa", label: "Humid subtropical", resolution_km: 5, source: "Beck et al. 2023, Koppen-Geiger 1991-2020", origin: "dataset_estimate" },
  cell_id: CELL_UNION, region_keys: ["US-NC", "US", "koppen:Cfa"], nc_region: "Piedmont",
});
write("geo-reverse-ocean", {
  meta: meta("reverse_ocean"), status: "unsupported", reason: "unsupported_location", reason_text: "This point is in open water, so there is no farm to test here.",
  place: null, hemisphere: "south", on_land: false, climate: null, cell_id: null, region_keys: [], nc_region: null,
});

// ------------------------------------------------------------------ §4 capabilities
const CAP_PERG = {
  weather: { status: "complete", job_status: "ready", cell_id: CELL_PERG, origin: "nasa_measured" },
  catalog: { status: "partial", origin: "ai_suggested", region_key: "AR-B", reason_text: "Suggestions found by AI research; check them with a local adviser." },
  soil: { status: "complete", provider: "soilgrids", resolution_m: 250, origin: "dataset_estimate" },
  live_weather: { status: "complete", provider: "open_meteo" },
  drought: { status: "unavailable", provider: null, reason: "no_provider_for_region", reason_text: "No drought monitor is connected for this country." },
  tools: { irrigation: "complete", fertilizer: "partial" },
};
const CAP_PERG_E = { ...CAP_PERG, weather: { status: "unknown", job_status: "pending", cell_id: CELL_PERG_E, origin: "nasa_measured" } };
const CAP_UNION = {
  weather: { status: "complete", job_status: "ready", cell_id: CELL_UNION, origin: "nasa_measured" },
  catalog: { status: "complete", origin: "verified_source", region_key: "US-NC", reason_text: null },
  soil: { status: "complete", provider: "usda_sda", resolution_m: null, origin: "verified_source" },
  live_weather: { status: "complete", provider: "nws" },
  drought: { status: "complete", provider: "usdm" },
  tools: { irrigation: "complete", fertilizer: "complete" },
};
write("capabilities-pergamino", { meta: meta("cap_perg"), region_key: "AR-B", features: CAP_PERG });
write("capabilities-union", { meta: meta("cap_union"), region_key: "US-NC", features: CAP_UNION });
write("capabilities-pending", { meta: meta("cap_pending"), region_key: "AR-B", features: CAP_PERG_E });

// ------------------------------------------------------------------ §5 farm analyze
let seed = 20261114;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const YEARS = Array.from({ length: 45 }, (_, i) => 1981 + i);

/** A synthetic Southern Hemisphere plan result (compare `plans[]` entry + A2's fields). */
function pergaminoResult(planId, label, plan, winterLabel, cover) {
  const springs = YEARS.map((y) => ({ y, mm: r2(40 + rnd() * 120) }));
  const sorted = [...springs].sort((a, b) => a.mm - b.mm);
  const cutoff = sorted[8].mm; // bottom 20%: 9th of 45 (fixture only; the backend computes the real one)
  const rank = new Map(sorted.map((s, i) => [s.y, i + 1]));
  const seasons = springs.map(({ y, mm }) => ({
    year: y, winter_status: "complete", spring_status: "complete", full_season_status: "complete",
    spring_total_mm: mm, spring_rank: rank.get(y), spring_is_dry: mm <= cutoff,
    rain_outside_cover_mm: r2((cover ? 60 : 180) + rnd() * 90), heavy_rain_days_outside_cover: rnd() < 0.2 ? 1 : 0,
    gwettop_window_mean: r2(0.4 + rnd() * 0.3), gwetroot_window_mean: r2(0.45 + rnd() * 0.3),
  }));
  const dry = seasons.filter((s) => s.spring_is_dry).map((s) => s.year);
  const era = (a, b) => {
    const ys = seasons.filter((s) => s.year >= a && s.year <= b);
    const ev = ys.filter((s) => s.spring_is_dry).length;
    return { start: a, end: b, seasons: 20, evaluable: 20, events: ev, pct: (ev / 20) * 100, not_evaluable: [] };
  };
  const e1 = era(1981, 2000), e2 = era(2006, 2025);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return {
    plan_id: planId, label, status: "complete", reason: null, reason_text: null, dates_assumed: false, editable: ["prev_harvest", "next_plant", "winter"],
    hemisphere: "south", season_label: winterLabel,
    plan,
    calendar: {
      reference_year: 2025, winter_days: 209, living_cover_days_planned: cover ? 172 : 0, days_without_planned_cover: cover ? 37 : 209,
      termination_gap_days: cover ? 26 : null, establishment: cover ? "complete" : "inapplicable", spring_window: { start: "10-16", end: "11-14" },
    },
    winter: {
      status: "complete", season_label: winterLabel, seasons: 45, eligible_seasons: 45,
      per_season_median: { rain_mm_outside_cover: median(seasons.map((s) => s.rain_outside_cover_mm)), heavy_rain_days_outside_cover: 0 },
      segments: cover ? ["fallow_before_cover", "cover", "gap_before_plant"] : ["no_planned_cover"],
    },
    spring: {
      status: "complete", season_label: "30 days before planting", window_days: 30, cutoff_mm: cutoff, eligible_seasons: 45, dry_seasons: dry.length,
      dry_years: dry, median_total_mm: median(springs.map((s) => s.mm)), shortcuts: { typical: seasons[20].year, dry: dry[0], wet: sorted[44].y, basis: "own_window_baseline" },
    },
    thresholds: {
      heavy_rain: { value: 41.7, unit: "mm/day", method: "etccdi_r95p", status: "complete", reference_span: "1981-01-01..2010-12-31", origin: "calculation", location: { cell_id: CELL_PERG } },
      dry_spring: { [plan.next_plant]: { value: cutoff, unit: "mm", method: "bottom_20pct_order_statistic", status: "complete", origin: "calculation", location: { cell_id: CELL_PERG } } },
    },
    spring_checks: [],
    other_checks: [
      {
        rule_id: "ar_b_ai_007", status: "manual_check", verdict: "manual_check", reason: "AI-found suggestion; check with a local adviser",
        text: "End the cover crop about three weeks before soybean planting so it can dry down.", print: false, origin: "source_checked",
        source: { title: "INTA cover crop guide (fixture)", url: "https://example.org/fixture/inta-cover-crops", locator: "p. 4" },
      },
      {
        rule_id: "ar_b_ai_012", status: "unknown", verdict: "unknown", reason: "AI-found suggestion; quote not found on the cited page",
        text: "Soybean after maize is commonly planted from mid-November in this region.", print: false, origin: "ai_suggested",
        source: { title: "Regional extension note (fixture)", url: "https://example.org/fixture/soy-dates", locator: null },
      },
    ],
    eras: {
      dry_spring: {
        indicator: "dry_spring", status: "complete", result: Math.abs(e2.pct - e1.pct) <= 10 ? "similar" : e2.pct > e1.pct ? "more_frequent_recent" : "less_frequent_recent",
        earlier: e1, recent: e2, diff_pp: e2.pct - e1.pct, min_evaluable_per_era: 15,
        caveat: "Descriptive comparison of two periods only; not a trend, cause, or forecast.",
      },
    },
    coverage: { available_years: YEARS },
    seasons,
  };
}

const PLAN_NORTH = {
  plan_id: "fld_1_plan", previous_crop_id: "maize", next_crop_id: "soybean", prev_harvest: "04-20",
  winter: { kind: "cover", crop_id: "cereal_rye", seed: "05-01", terminate: "10-20" }, next_plant: "11-15", grower: { low_moisture_concern: null },
};
const PLAN_SOUTH = {
  plan_id: "fld_2_plan", previous_crop_id: "soybean", next_crop_id: "maize", prev_harvest: "05-10",
  winter: { kind: "none" }, next_plant: "09-25", grower: { low_moisture_concern: null },
};
const PLAN_EAST = { ...PLAN_SOUTH, plan_id: "fld_3_plan" };
const LABEL_S = "Off-season (May–Oct)";
const resNorth = pergaminoResult("fld_1_plan", "Maize, cereal rye cover, soybean", PLAN_NORTH, LABEL_S, true);
const resSouth = pergaminoResult("fld_2_plan", "Soybean, no cover, maize", PLAN_SOUTH, LABEL_S, false);
resSouth.calendar.spring_window = { start: "08-26", end: "09-24" };

const field = (id, name, geomKey, cell, centroid, capabilities, result, job = "ready") => ({
  field_id: id, name, area_ha: ha(POLYGONS[geomKey]), area_ac: ac(POLYGONS[geomKey]), centroid, cell_id: cell, job_status: job, capabilities, result,
  ...(job === "pending" ? { poll: `/v1/weather/${cell}` } : {}),
});
const SHARED = "These fields share one NASA weather series; differences between them come from their plans, not their weather.";
const totals = (fs) => ({ area_ha: r2(fs.reduce((a, f) => a + f.area_ha, 0)), area_ac: r2(fs.reduce((a, f) => a + f.area_ac, 0)) });

const twoFields = [
  field("fld_1", "North 40", "pergamino_square", CELL_PERG, { latitude: -33.89, longitude: -60.58 }, CAP_PERG, resNorth),
  field("fld_2", "South L", "pergamino_l", CELL_PERG, { latitude: -33.91, longitude: -60.6 }, CAP_PERG, resSouth),
];
write("farm-two-fields-one-cell", {
  meta: meta("farm_2f1c"), status: "complete", fields: twoFields,
  weather_cells: [{ cell_id: CELL_PERG, field_ids: ["fld_1", "fld_2"], note: SHARED }], totals: totals(twoFields),
});

const threeFields = [
  ...twoFields,
  field("fld_3", "East block", "pergamino_east", CELL_PERG_E, { latitude: -33.9, longitude: -60.26 }, CAP_PERG_E, null, "pending"),
];
write("farm-three-fields-two-cells", {
  meta: meta("farm_3f2c"), status: "partial", fields: threeFields,
  weather_cells: [
    { cell_id: CELL_PERG, field_ids: ["fld_1", "fld_2"], note: SHARED },
    { cell_id: CELL_PERG_E, field_ids: ["fld_3"], note: SHARED },
  ],
  totals: totals(threeFields),
});

// The NC field reuses the saved real sample entry for soy_corn__rye.
const compare = JSON.parse(readFileSync(join(root, "public/data/nasa/compare.json"), "utf8"));
const nc = structuredClone(compare.plans.find((p) => p.plan_id === "soy_corn__rye"));
nc.plan_id = "fld_nc_plan";
nc.plan.plan_id = "fld_nc_plan";
nc.hemisphere = "north";
nc.season_label = "Winter";
nc.winter.season_label = "Winter";
nc.spring.season_label = "30 days before planting";
nc.coverage = { available_years: YEARS };
nc.thresholds = {
  heavy_rain: { ...compare.thresholds.heavy_rain, method: "fixed_published", origin: "verified_source", location: { cell_id: CELL_UNION } },
  dry_spring: Object.fromEntries(Object.entries(compare.thresholds.dry_spring).map(([k, t]) => [k, { ...t, origin: "calculation", location: { cell_id: CELL_UNION } }])),
};
for (const c of nc.other_checks) c.origin = "verified_source";
const mixed = [
  field("fld_nc", "Home place", "union_parcels", CELL_UNION, { latitude: 34.98, longitude: -80.55 }, CAP_UNION, nc),
  twoFields[0],
];
write("farm-mixed-nc-pergamino", {
  meta: meta("farm_mixed"), status: "complete", fields: mixed,
  weather_cells: [
    { cell_id: CELL_UNION, field_ids: ["fld_nc"], note: SHARED },
    { cell_id: CELL_PERG, field_ids: ["fld_1"], note: SHARED },
  ],
  totals: totals(mixed),
});
write("farm-invalid-bowtie", {
  meta: meta("farm_bad"), status: "invalid_input",
  issues: [{ field: "farm.fields[0].geometry", code: "self_intersection", message: "Field 'Bowtie' crosses itself; redraw its boundary." }],
});

// ------------------------------------------------------------------ §6 profile and research
const sage = { title: "Sacks et al. 2010 crop calendar", url: "https://sage.nelson.wisc.edu/data-and-models/datasets/crop-calendar-dataset/" };
write("profile-ar-b", {
  meta: meta("profile_arb"), region_key: "AR-B", status: "partial",
  research: { job_status: "ready", generated_at: "2026-11-14T10:00:00Z", model: "claude-sonnet-5-5" },
  crops: [
    { crop_id: "soybean", name: "Soybean", roles: ["cash"], calendar: { plant: { start: "10-15", end: "12-31" }, harvest: { start: "03-15", end: "05-31" }, origin: "dataset_estimate", source: sage } },
    { crop_id: "maize", name: "Maize", roles: ["cash"], calendar: { plant: { start: "09-15", end: "12-15" }, harvest: { start: "03-01", end: "07-15" }, origin: "dataset_estimate", source: sage } },
    { crop_id: "wheat", name: "Wheat", roles: ["cash", "winter_grain"], calendar: { plant: { start: "05-15", end: "07-15" }, harvest: { start: "11-15", end: "12-31" }, origin: "dataset_estimate", source: sage } },
  ],
  cover_crops: [
    { crop_id: "cereal_rye", name: "Cereal rye", origin: "ai_suggested", sources: [] },
    { crop_id: "oats", name: "Oats", origin: "source_checked", sources: [{ title: "INTA cover crop guide (fixture)", url: "https://example.org/fixture/inta-cover-crops", locator: "p. 2" }] },
  ],
  rotations: [
    { label: "Maize → winter cover → soybean", origin: "source_checked", sources: [{ title: "INTA cover crop guide (fixture)", url: "https://example.org/fixture/inta-cover-crops", locator: "p. 3" }] },
    { label: "Wheat / double-crop soybean", origin: "ai_suggested", sources: [] },
  ],
  rules: [
    {
      rule_id: "ar_b_ai_007", text: "End the cover crop about three weeks before soybean planting so it can dry down.", origin: "source_checked",
      evidence_quote: "terminar el cultivo de cobertura unas tres semanas antes de la siembra", source: { title: "INTA cover crop guide (fixture)", url: "https://example.org/fixture/inta-cover-crops", locator: "p. 4" },
      conflicts_with: ["ar_b_ai_009"], limitations: "Written for the core Pampas region; drier western areas may differ.",
    },
    {
      rule_id: "ar_b_ai_009", text: "End the cover crop at least 45 days before soybean planting in dry years.", origin: "ai_suggested",
      evidence_quote: "al menos 45 días antes de la siembra en años secos", source: { title: "Regional extension note (fixture)", url: "https://example.org/fixture/soy-dates", locator: null },
      conflicts_with: ["ar_b_ai_007"], limitations: null,
    },
  ],
  gaps: ["No local source found for cover termination timing before soybean."],
  disclaimer: "AI-found suggestions to check with a local adviser; not verified advice.",
});
write("profile-us-nc", {
  meta: meta("profile_nc"), region_key: "US-NC", status: "complete", research: null,
  crops: [
    { crop_id: "maize", name: "Corn", roles: ["cash"], calendar: { plant: { start: "04-01", end: "05-15" }, harvest: { start: "08-15", end: "10-31" }, origin: "verified_source", source: { title: "NC State Corn Production Guide", url: "https://corn.ces.ncsu.edu/" } } },
    { crop_id: "soybean", name: "Soybean", roles: ["cash"], calendar: { plant: { start: "05-01", end: "06-30" }, harvest: { start: "10-01", end: "11-30" }, origin: "verified_source", source: { title: "NC State Soybean Production Guide", url: "https://soybeans.ces.ncsu.edu/" } } },
  ],
  cover_crops: [{ crop_id: "cereal_rye", name: "Cereal rye", origin: "verified_source", sources: [{ title: "NC State cover crop guide", url: "https://www.carolinacovers.org/" }] }],
  rotations: [{ label: "Corn → rye cover → soybean", origin: "verified_source", sources: [] }],
  rules: [],
  gaps: [],
  disclaimer: null,
});
write("research-pending", { meta: meta("research_pending"), job_id: "rj_fixture_1", job_status: "pending", region_key: "AR-B" });
write("research-ready", { meta: meta("research_ready"), job_id: "rj_fixture_1", job_status: "ready", region_key: "AR-B", profile_url: "/v1/regions/AR-B/profile" });
write("research-unavailable", {
  meta: meta("research_off"), job_id: null, job_status: "failed", region_key: "AR-B", status: "unavailable", reason: "research_not_configured",
  reason_text: "AI research is not set up on this service; the crop calendar dataset is used instead.",
});

// ------------------------------------------------------------------ §7 tools with area
write("tools-fertilizer-area", {
  meta: meta("tools_fert"), status: "complete", units: "metric",
  per_area: { value: 134.5, unit: "kg N/ha", origin: "calculation" },
  field_total: { value: 1345, unit: "kg N", origin: "calculation" },
});

console.log(`fixtures written to ${out}`);
for (const [k, g] of Object.entries(POLYGONS)) console.log(k.padEnd(18), ha(g), "ha");
