import { useEffect, useState } from "react";
import type { GlobalClient } from "../api/client";
import type { LatLon, PlaceInfo, RegionProfile } from "../api/model";
import { centroid } from "../farm/geometry";
import type { Field } from "../farm/types";

/*
  The place and regional profile for one field: reverse-geocode its display centroid, then the
  first region key with a profile (most specific first, as the backend lists them). Cached per
  rounded point so switching fields is instant. The point goes only to the service.
*/
export type Loadable<T> = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };
export interface FieldPlace {
  point: LatLon;
  place: Loadable<PlaceInfo>;
  profile: Loadable<RegionProfile>;
}

const cache = new Map<string, { place: Loadable<PlaceInfo>; profile: Loadable<RegionProfile> }>();

export function fieldPoint(field: Field): LatLon {
  const c = centroid(field.geometry);
  return { latitude: Math.round(c.latitude * 100) / 100, longitude: Math.round(c.longitude * 100) / 100 };
}

export function useFieldPlace(client: GlobalClient, field: Field | null): FieldPlace | null {
  const point = field ? fieldPoint(field) : null;
  const key = point ? `${point.latitude},${point.longitude}` : null;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!key || !point || cache.has(key)) return;
    let live = true;
    cache.set(key, { place: { state: "loading" }, profile: { state: "idle" } });
    bump((n) => n + 1);
    (async () => {
      const p = await client.geoReverse(point);
      if (!p.ok) {
        cache.set(key, { place: { state: "error", message: p.message }, profile: { state: "idle" } });
        if (live) bump((n) => n + 1);
        return;
      }
      cache.set(key, { place: { state: "ready", data: p.data }, profile: { state: "loading" } });
      if (live) bump((n) => n + 1);
      let profile: Loadable<RegionProfile> = { state: "error", message: "No regional profile for this place yet." };
      for (const k of p.data.regionKeys) {
        const r = await client.regionProfile(k);
        if (r.ok) {
          profile = { state: "ready", data: r.data };
          break;
        }
      }
      cache.set(key, { place: { state: "ready", data: p.data }, profile });
      if (live) bump((n) => n + 1);
    })();
    return () => {
      live = false;
      // A cancelled lookup is tried again next time.
      if (cache.get(key)?.place.state === "loading") cache.delete(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client]);

  if (!point || !key) return null;
  const c = cache.get(key) ?? { place: { state: "loading" as const }, profile: { state: "idle" as const } };
  return { point, ...c };
}

export function resetFieldPlaceCache() {
  cache.clear();
}
