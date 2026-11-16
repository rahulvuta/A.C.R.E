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

// Every hook showing the same point is told when its lookup moves on, so one request serves
// all of them (the field cards, the workspace and its sections) instead of one each.
const listeners = new Map<string, Set<() => void>>();
const regionProfiles = new Map<string, Promise<Loadable<RegionProfile> | null>>();

function publish(key: string, value: { place: Loadable<PlaceInfo>; profile: Loadable<RegionProfile> }) {
  cache.set(key, value);
  listeners.get(key)?.forEach((f) => f());
}

function profileFor(client: GlobalClient, regionKey: string): Promise<Loadable<RegionProfile> | null> {
  let p = regionProfiles.get(regionKey);
  if (!p) {
    p = client.regionProfile(regionKey).then((r) => (r.ok ? { state: "ready" as const, data: r.data } : null));
    regionProfiles.set(regionKey, p);
    // A failed profile may be tried again later.
    void p.then((v) => (v ? undefined : regionProfiles.delete(regionKey)));
  }
  return p;
}

function load(client: GlobalClient, key: string, point: LatLon) {
  publish(key, { place: { state: "loading" }, profile: { state: "idle" } });
  void (async () => {
    const p = await client.geoReverse(point);
    if (!p.ok) {
      // An error is shown, then forgotten, so the next view of this field tries again.
      publish(key, { place: { state: "error", message: p.message }, profile: { state: "idle" } });
      cache.delete(key);
      return;
    }
    publish(key, { place: { state: "ready", data: p.data }, profile: { state: "loading" } });
    let profile: Loadable<RegionProfile> = { state: "error", message: "No regional profile for this place yet." };
    for (const k of p.data.regionKeys) {
      const r = await profileFor(client, k);
      if (r) {
        profile = r;
        break;
      }
    }
    publish(key, { place: { state: "ready", data: p.data }, profile });
  })();
}

export function useFieldPlace(client: GlobalClient, field: Field | null): FieldPlace | null {
  const point = field ? fieldPoint(field) : null;
  const key = point ? `${point.latitude},${point.longitude}` : null;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!key || !point) return;
    const on = () => bump((n) => n + 1);
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(on);
    if (!cache.has(key)) load(client, key, point);
    else on();
    return () => {
      set!.delete(on);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client]);

  if (!point || !key) return null;
  const c = cache.get(key) ?? { place: { state: "loading" as const }, profile: { state: "idle" as const } };
  return { point, ...c };
}

export function resetFieldPlaceCache() {
  cache.clear();
  regionProfiles.clear();
}
