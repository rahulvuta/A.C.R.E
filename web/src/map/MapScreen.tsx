import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import type { GeoHit, LatLon } from "../api/model";
import { Segmented } from "../ui/components";
import { BASEMAPS, BASEMAP_KEYS, FIRST_BASEMAP, type Basemap } from "./basemap";
import { Greenness } from "./Greenness";
import type { GeoApi } from "./geoApi";
import { roundCoord } from "./geoApi";
import { LocationCard, type Pick } from "./LocationCard";
import { MapView, type Bounds } from "./MapView";
import { suggestUnits } from "../ui/units";
import "./map.css";

/*
  Find a farm on the map (card C1): search a place or type coordinates, or click the map.
  A pin asks the backend what the place is and what A.C.R.E can use there.
*/
export interface MapScreenProps {
  api: GeoApi;
  /** Called whenever a point is picked and both answers are in (or failed). */
  onPick?: (pick: Pick) => void;
  /** Rendered under the location card, e.g. "Start a farm here". */
  pickAction?: (pick: Pick) => ReactNode;
  /** Extra panel content under the search (C2: the farm editor). */
  children?: ReactNode;
  onMapReady?: (map: MlMap) => void;
  /** Open the map on this area (west, south, east, north) instead of the whole world. */
  initialBounds?: Bounds | null;
  /**
   * Sees every map click first; return true when it handled the click (a drawing tool, a
   * click on a field), and the pin does not move.
   */
  onMapClick?: (p: LatLon, screen: { x: number; y: number }) => boolean;
}

export function MapScreen({ api, onPick, pickAction, children, onMapReady, initialBounds, onMapClick }: MapScreenProps) {
  const [basemap, setBasemap] = useState<Basemap>(FIRST_BASEMAP);
  // The satellite provider refused its tiles: the street map is shown instead, and the grower is told why.
  const [photoDown, setPhotoDown] = useState(false);
  // Reaching for the switch starts fetching the other base map, so the switch itself is instant;
  // after that both are kept in step for the rest of the visit. Nothing is fetched ahead for a
  // grower who never goes near it (the street map's rules forbid fetching tiles nobody asked for).
  const [warm, setWarm] = useState(false);
  const warmUp = useCallback(() => setWarm(true), []);
  const basemapFailed = useCallback((b: Basemap) => {
    if (b !== "satellite" || !BASEMAPS.streets) return;
    setPhotoDown(true);
    setBasemap((now) => (now === "satellite" ? "streets" : now));
  }, []);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; hits: GeoHit[]; coords: boolean; credit?: { text: string; url: string | null } | null }>({ state: "idle" });
  const [pick, setPick] = useState<Pick | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  // The same map as state, for the parts drawn beside it (the greenness switch).
  const [liveMap, setLiveMap] = useState<MlMap | null>(null);
  const pinRef = useRef<maplibregl.Marker | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const pickAbort = useRef<AbortController | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  // A search answered before the map finished loading: applied once it is ready.
  const pendingHit = useRef<GeoHit | null>(null);

  useEffect(() => () => {
    searchAbort.current?.abort();
    pickAbort.current?.abort();
  }, []);

  const showPin = useCallback((point: LatLon) => {
    const map = mapRef.current;
    if (!map) return;
    if (!pinRef.current) {
      const el = document.createElement("div");
      el.className = "mp-pin";
      el.setAttribute("aria-label", "Picked point");
      el.setAttribute("role", "img");
      pinRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" });
    }
    pinRef.current.setLngLat([point.longitude, point.latitude]).addTo(map);
  }, []);

  const placePin = useCallback(
    (raw: LatLon) => {
      const point = { latitude: roundCoord(raw.latitude), longitude: roundCoord(raw.longitude) };
      showPin(point);
      pickAbort.current?.abort();
      const ctl = new AbortController();
      pickAbort.current = ctl;
      let current: Pick = { point, place: { state: "loading" }, caps: { state: "loading" } };
      setPick(current);
      const update = (next: Partial<Pick>) => {
        if (ctl.signal.aborted) return;
        current = { ...current, ...next };
        setPick(current);
        if (current.place.state !== "loading" && current.caps.state !== "loading") onPickRef.current?.(current);
      };
      void api.reverse(point.latitude, point.longitude, ctl.signal).then((r) => {
        // The place a grower searches for or pins sets the units (hectares or acres, and so on) until they choose their own.
        if (r.ok && !ctl.signal.aborted) suggestUnits(r.data.country);
        update({ place: r.ok ? { state: "ready", data: r.data } : { state: "error", message: r.message } });
      });
      void api.capabilities(point.latitude, point.longitude, ctl.signal).then((r) => update({ caps: r.ok ? { state: "ready", data: r.data } : { state: "error", message: r.message } }));
    },
    [api, showPin],
  );

  const flyTo = useCallback((hit: GeoHit) => {
    const map = mapRef.current;
    if (!map) {
      pendingHit.current = hit;
      return;
    }
    // Straight there, no flight: a flight across the world fetches tiles all along the way and
    // the place itself only starts loading when it lands.
    if (hit.bbox) map.fitBounds([[hit.bbox[0], hit.bbox[1]], [hit.bbox[2], hit.bbox[3]]], { padding: 40, maxZoom: 15, duration: 0 });
    else map.jumpTo({ center: [hit.point.longitude, hit.point.latitude], zoom: 15 });
  }, []);

  const choose = useCallback(
    (hit: GeoHit) => {
      flyTo(hit);
      placePin(hit.point);
    },
    [flyTo, placePin],
  );

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    searchAbort.current?.abort();
    const ctl = new AbortController();
    searchAbort.current = ctl;
    setSearch({ state: "loading" });
    const r = await api.search(q, ctl.signal);
    if (ctl.signal.aborted) return;
    if (!r.ok) return setSearch({ state: "error", message: r.message });
    setSearch({ state: "ready", hits: r.data.hits, coords: r.data.queryKind === "coordinates", credit: r.data.credit });
    // Typed coordinates are a point, not a question: go straight there.
    if (r.data.queryKind === "coordinates" && r.data.hits.length === 1) choose(r.data.hits[0]!);
  };

  // A click on the map is a newer choice than any search still in flight.
  const mapClick = useCallback(
    (p: LatLon, screen: { x: number; y: number }) => {
      if (onMapClickRef.current?.(p, screen)) return;
      searchAbort.current?.abort();
      pendingHit.current = null;
      setSearch((s) => (s.state === "loading" ? { state: "idle" } : s));
      placePin(p);
    },
    [placePin],
  );

  const ready = useCallback(
    (map: MlMap) => {
      mapRef.current = map;
      setLiveMap(map);
      onMapReady?.(map);
      const hit = pendingHit.current;
      pendingHit.current = null;
      if (hit) {
        flyTo(hit);
        showPin({ latitude: roundCoord(hit.point.latitude), longitude: roundCoord(hit.point.longitude) });
      }
    },
    [onMapReady, flyTo, showPin],
  );

  return (
    <div className="mp-screen">
      <aside className="mp-panel" aria-label="Farm panel">
        <form className="mp-search" role="search" onSubmit={runSearch}>
          <label htmlFor="mp-q" className="mp-label">
            Find your farm
          </label>
          <div className="mp-search-row">
            <input
              id="mp-q"
              className="input mp-input"
              type="search"
              value={query}
              autoComplete="off"
              placeholder="Town, address or coordinates"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={search.state === "loading"}>
              Search
            </button>
          </div>
        </form>
        {search.state === "loading" ? <p className="mp-quiet" role="status">Searching…</p> : null}
        {search.state === "error" ? <p className="mp-error" role="alert">{search.message}</p> : null}
        {search.state === "ready" && search.hits.length === 0 ? <p className="mp-quiet" role="status">No place found. Try a nearby town or type coordinates.</p> : null}
        {search.state === "ready" && search.hits.length > 0 && !(search.coords && search.hits.length === 1) ? (
          <ul className="mp-results" aria-label="Search results">
            {search.hits.map((h, i) => (
              <li key={`${h.label}-${i}`}>
                <button type="button" className="mp-result" translate="no" onClick={() => choose(h)}>
                  {h.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {search.state === "ready" && search.hits.length > 0 && search.credit ? (
          <p className="mp-credit">
            {search.credit.url ? (
              <a href={search.credit.url} target="_blank" rel="noreferrer">
                {search.credit.text}
              </a>
            ) : (
              search.credit.text
            )}
          </p>
        ) : null}
        {pick ? <LocationCard pick={pick} action={pickAction?.(pick)} /> : <p className="mp-quiet">Search, or click the map to drop a pin.</p>}
        {children}
      </aside>
      <div className="mp-stage">
        <MapView basemap={basemap} warmOthers={warm} initialBounds={initialBounds} onClick={mapClick} onReady={ready} onBasemapFailed={basemapFailed} label="Farm map" />
        {BASEMAP_KEYS.length > 1 ? (
          <div className="mp-layer-switch" onPointerEnter={warmUp} onPointerDown={warmUp} onFocus={warmUp}>
            <Segmented label="Basemap" value={basemap} onChange={setBasemap} options={BASEMAP_KEYS.map((k) => ({ value: k, label: BASEMAPS[k]!.label }))} />
          </div>
        ) : null}
        <Greenness map={liveMap} />
        {photoDown ? (
          <p className="mp-photo-down" role="status">
            {basemap === "satellite" ? "Satellite photo is not loading." : "Satellite photo is not loading. Showing the street map."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
