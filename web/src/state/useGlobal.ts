import { useMemo } from "react";
import { createGlobalClient, type GlobalClient } from "../api/client";
import { FIXTURE_API_BASE, fixtureFetch } from "../api/fixtures";
import { geoApiFrom, type MapGeoApi } from "../api/geoApi";
import { API_BASE, FIXTURE_MODE, GLOBAL_TIMEOUT_MS } from "../config";

/** How the global screens reach the backend: the live service, the labelled fixtures, or nothing. */
export type Source = "live" | "fixtures" | "none";

export interface GlobalApi {
  client: GlobalClient;
  geo: MapGeoApi;
  source: Source;
}

export function makeGlobalApi(source: Source = API_BASE ? "live" : FIXTURE_MODE ? "fixtures" : "none"): GlobalApi {
  const client =
    source === "fixtures"
      ? createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: GLOBAL_TIMEOUT_MS, fetchImpl: fixtureFetch(150) })
      : createGlobalClient({ apiBase: source === "live" ? API_BASE : null, timeoutMs: GLOBAL_TIMEOUT_MS });
  return { client, geo: geoApiFrom(client), source };
}

export function useGlobalApi(): GlobalApi {
  return useMemo(() => makeGlobalApi(), []);
}
