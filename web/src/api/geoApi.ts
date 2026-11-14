import type { Capabilities, GeoSearch, PlaceInfo } from "./model";
import type { GlobalClient } from "./client";

/*
  The map's geo calls (C1's `GeoApi` in map/geoApi.ts, same shape) served by the global
  client, so the map reads the backend through adapt.ts like every other screen. A cancelled
  request's answer is dropped by the map itself (it checks its own AbortSignal).
*/
export type GeoAnswer<T> = { ok: true; data: T } | { ok: false; message: string };
export interface MapGeoApi {
  search(q: string, signal?: AbortSignal): Promise<GeoAnswer<GeoSearch>>;
  reverse(lat: number, lon: number, signal?: AbortSignal): Promise<GeoAnswer<PlaceInfo>>;
  capabilities(lat: number, lon: number, signal?: AbortSignal): Promise<GeoAnswer<Capabilities>>;
}

export function geoApiFrom(client: GlobalClient): MapGeoApi {
  const out = <T,>(r: { ok: true; data: T } | { ok: false; message: string }): GeoAnswer<T> => (r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message });
  return {
    search: async (q) => out(await client.geoSearch(q)),
    reverse: async (lat, lon) => out(await client.geoReverse({ latitude: lat, longitude: lon })),
    capabilities: async (lat, lon) => out(await client.capabilities({ latitude: lat, longitude: lon })),
  };
}
