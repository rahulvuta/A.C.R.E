import { futureResponseSchema, generateResponseSchema, recommendationCandidateSchema, recommendResponseSchema, type FutureRequest, type Indicator, type Plan } from "./api";

// Synthetic test data. Dates and quantities here are not agricultural guidance.
export const point = {
  latitude: 34.98,
  longitude: -80.55
};
export const field = {
  field_id: "synthetic_field",
  crop_history: ["field_corn"],
  soil: null
};
export const plans: Plan[] = [{
  plan_id: "synthetic_s1",
  previous_crop_id: "field_corn",
  prev_harvest: "09-20",
  winter: {
    kind: "cover",
    crop_id: "cereal_rye",
    seed: "09-27",
    terminate: "04-08"
  },
  next_crop_id: "soybean",
  next_plant: "05-15",
  grower: {
    low_moisture_concern: null
  }
}, {
  plan_id: "synthetic_s2",
  previous_crop_id: "soybean",
  prev_harvest: "10-20",
  winter: {
    kind: "cover",
    crop_id: "cereal_rye",
    seed: "10-27",
    terminate: "04-01"
  },
  next_crop_id: "field_corn",
  next_plant: "04-15"
}];
export const generated = generateResponseSchema.parse({
  status: "complete",
  candidates: [{
    candidate_id: "rye",
    label: "Rye cover rotation",
    seasons: plans.map((plan, i) => ({
      season: i + 1,
      year: 2027 + i,
      plan,
      origins: {
        prev_harvest: "assumed",
        next_plant: "dataset_estimate",
        "winter.seed": "verified_source",
        "winter.terminate": "assumed"
      }
    })),
    origins: ["assumed", "dataset_estimate", "verified_source"]
  }],
  generation_log: [],
  gaps: []
});
function indicator(value: number | null, unit: string, direction: Indicator["direction"] = "lower_better"): Indicator {
  return {
    value,
    unit,
    direction,
    origin: "calculation",
    status: value === null ? "unknown" : "complete",
    definition: "Synthetic indicator definition.",
    source: {
      title: "Synthetic source",
      url: "https://example.org/evidence"
    },
    per_leg: [value, value]
  };
}
export const candidate = recommendationCandidateSchema.parse({
  candidate_id: "rye",
  label: "Rye cover rotation",
  origin: "generated",
  plans,
  indicators: {
    rain_on_bare_soil_mm: indicator(40.6, "mm per season"),
    management_operations: indicator(4, "operations per season"),
    irrigation_dependence: indicator(null, "none")
  },
  rank_positions: {
    rain_on_bare_soil_mm: 2,
    management_operations: 1
  },
  why: [{
    text: "This rye plan has fewer management operations in the synthetic comparison.",
    source: {
      title: "Synthetic source",
      url: "https://example.org/evidence"
    }
  }],
  trade_offs: [{
    text: "The alternative has less historical rain on bare soil."
  }],
  uncertainties: [{
    text: "Cover establishment is uncertain.",
    origin: "assumed"
  }],
  historical_vulnerabilities: [{
    year: "1990",
    text: "1990 had more rain outside planned cover in this fixture.",
    plan_id: plans[0]!.plan_id,
    replay: {
      method: "POST",
      path: "/v1/seasons/1990/replay",
      body: {
        plan: plans[0],
        location: point
      }
    }
  }]
});
export const alternative = recommendationCandidateSchema.parse({
  ...candidate,
  candidate_id: "alternative",
  label: "Grain rotation",
  indicators: {
    rain_on_bare_soil_mm: indicator(37.8, "mm per season"),
    management_operations: indicator(6, "operations per season")
  },
  rank_positions: {
    rain_on_bare_soil_mm: 1,
    management_operations: 2
  }
});
export const recommendation = recommendResponseSchema.parse({
  status: "complete",
  method: {
    indicators_used: ["rain_on_bare_soil_mm", "management_operations"],
    note: "Depends on these priorities and this weather history."
  },
  shortlist: [candidate, alternative],
  dominated: [{
    ...candidate,
    candidate_id: "bare",
    label: "Bare rotation",
    dominated_by: ["rye"]
  }],
  not_comparable: [{
    ...candidate,
    candidate_id: "missing",
    label: "Unevaluated rotation",
    missing: ["rule_flags"]
  }],
  gaps: []
});
export const insufficient = recommendResponseSchema.parse({
  status: "insufficient_data",
  shortlist: [],
  gaps: ["No regional source for cover termination.", "Missing historical weather for this location."]
});
export function futureResponse(request?: Pick<FutureRequest, "edits">) {
  const edits = request?.edits ?? [];
  const getDate = (season: number, path: string, initial: string) => {
    const edit = edits.find(e => e.season === season && e.field === path);
    return edit ? `${initial.slice(0, 5)}${edit.value}` : initial;
  };
  const changed = edits.length > 0;
  return futureResponseSchema.parse({
    status: "complete",
    note: "Planned dates. They cannot say what the weather in these seasons will bring.",
    seasons: plans.map((plan, i) => ({
      season: String(2027 + i),
      status: "complete",
      plan,
      windows: [{
        kind: "harvest",
        label: "Harvest previous crop",
        start: `${2026 + i}-09-20`,
        end: `${2026 + i}-09-20`,
        origin: "assumed",
        field: "prev_harvest"
      }, {
        kind: "cover_seed",
        label: "Seed rye",
        start: `${2026 + i}-09-27`,
        end: `${2026 + i}-09-27`,
        origin: "verified_source",
        field: "winter.seed"
      }, {
        kind: "cover_terminate",
        label: "Terminate rye",
        start: getDate(i + 1, "winter.terminate", `${2027 + i}-04-08`),
        end: getDate(i + 1, "winter.terminate", `${2027 + i}-04-08`),
        origin: edits.some(e => e.season === i + 1 && e.field === "winter.terminate") ? "grower" : "assumed",
        field: "winter.terminate"
      }, {
        kind: "plant",
        label: "Plant next crop",
        start: getDate(i + 1, "next_plant", `${2027 + i}-05-15`),
        end: getDate(i + 1, "next_plant", `${2027 + i}-05-15`),
        origin: edits.some(e => e.season === i + 1 && e.field === "next_plant") ? "grower" : "dataset_estimate",
        field: "next_plant"
      }],
      cover_schedule: {
        crop_id: "cereal_rye",
        seed: `${2026 + i}-09-27`,
        terminate: getDate(i + 1, "winter.terminate", `${2027 + i}-04-08`),
        origin: {
          seed: "verified_source",
          terminate: changed ? "grower" : "assumed"
        },
        establishment: "uncertain",
        living_cover_days: 193
      },
      milestones: [{
        date: `${2027 + i}-04-01`,
        label: "Check cover condition",
        origin: "calculation"
      }],
      decision_deadlines: [{
        date: changed ? `${2027 + i}-04-03` : `${2027 + i}-04-08`,
        decision: "Keep this plan or switch",
        switch_condition: "Review the field observations.",
        next_check_date: changed ? `${2027 + i}-03-27` : `${2027 + i}-04-01`,
        origin: "calculation"
      }],
      backup: {
        status: "complete",
        fallback_plan_id: "synthetic_backup",
        switch_condition: {
          text: "Review the field observations before switching."
        }
      },
      warnings: [],
      historical_vulnerabilities: []
    })),
    ...(changed ? {
      diff: {
        changes: [{
          season: "2027",
          plan_edits: edits.map(e => ({
            field: e.field,
            before: "04-08",
            after: e.value
          })),
          changes: [{
            label_after: "Terminate rye",
            date_before: "2027-04-08",
            date_after: "2027-04-03",
            why: ["Grower date changed."]
          }],
          decision_deadline: {
            before: "2027-04-08",
            after: "2027-04-03",
            next_check_before: "2027-04-01",
            next_check_after: "2027-03-27"
          }
        }]
      },
      recommendation_refresh: {
        status: "complete",
        indicators: {
          rain_on_bare_soil_mm: indicator(42.3, "mm per season")
        },
        method: {
          indicators_used: ["rain_on_bare_soil_mm"]
        }
      }
    } : {})
  });
}
export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json"
  }
});
