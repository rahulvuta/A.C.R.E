import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { BASEMAP_KEYS, baseStyle, layerId, tileWatch, warmTileHosts, type Basemap } from "./basemap";
import type { LatLon } from "../api/model";

/*
  The MapLibre map: satellite and streets basemaps, zoom buttons, a scale bar and an
  attribution line that is always expanded. Other parts (the pin, drawing, results layer)
  get the live map through `onReady`. The view's centre and zoom are mirrored onto the
  container as data attributes so tests can read where the map went.
*/
// MapLibre finds its worker next to its own module, which Vite's bundling moves; point at it.
maplibregl.setWorkerUrl(workerUrl);
// Fetch more tiles at once than the library's default of 16: a full map view is 20 to 40 tiles.
maplibregl.setMaxParallelImageRequests(32);

/** West, south, east, north, in degrees. */
export type Bounds = [number, number, number, number];

export interface MapViewProps {
  initialCenter?: LatLon;
  initialZoom?: number;
  /**
   * Open on this area instead of the whole world. A saved farm is shown at once: no world
   * tiles are fetched first and nothing flies across the globe.
   */
  initialBounds?: Bounds | null;
  /**
   * Also fetch the base maps that are not on screen, invisibly, for the view the grower is
   * looking at, so switching to one is instant. Off until the grower reaches for the switch.
   */
  warmOthers?: boolean;
  basemap: Basemap;
  /** A map click that is not handled by a drawing tool. */
  onClick?: (p: LatLon, screen: { x: number; y: number }) => void;
  onReady?: (map: MlMap) => void;
  /**
   * A base map whose tiles are being refused: several failed, and far more failed than
   * arrived. The satellite provider can block requests; the caller can then show the other
   * base map.
   */
  onBasemapFailed?: (basemap: Basemap) => void;
  label?: string;
}

export function MapView({ initialCenter = { latitude: 20, longitude: 0 }, initialZoom = 1.6, initialBounds, warmOthers = false, basemap, onClick, onReady, onBasemapFailed, label = "Map" }: MapViewProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const failedRef = useRef(onBasemapFailed);
  failedRef.current = onBasemapFailed;
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let map: MlMap;
    warmTileHosts();
    try {
      map = new maplibregl.Map({
        container: host.current,
        style: baseStyle(basemap),
        ...(initialBounds
          ? { bounds: [[initialBounds[0], initialBounds[1]], [initialBounds[2], initialBounds[3]]] as [[number, number], [number, number]], fitBoundsOptions: { padding: 80, maxZoom: 16 } }
          : { center: [initialCenter.longitude, initialCenter.latitude] as [number, number], zoom: initialZoom }),
        // Tiles and labels appear the moment they arrive, with no fade.
        fadeDuration: 0,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        // Tests and screenshots read the canvas.
        canvasContextAttributes: { preserveDrawingBuffer: true },
      });
    } catch {
      setFailed("This browser could not start the map (WebGL is needed).");
      return;
    }
    mapRef.current = map;
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(host.current);
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");
    const el = host.current;
    const mirror = () => {
      const c = map.getCenter();
      el.dataset.center = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
      el.dataset.zoom = map.getZoom().toFixed(2);
    };
    mirror();
    map.on("moveend", mirror);
    map.on("click", (e) => {
      // A click on a repeated world copy is wrapped back into -180..180.
      const p = e.lngLat.wrap();
      clickRef.current?.({ latitude: p.lat, longitude: p.lng }, e.point);
    });
    // Ready as soon as the style is in, not when every tile of the first view has arrived:
    // fields, the pin and the drawing tools do not wait for the photo.
    let told = false;
    const tell = () => {
      if (told) return;
      told = true;
      el.dataset.ready = "true";
      onReady?.(map);
    };
    map.once("style.load", tell);
    map.once("load", tell);
    // A base map that is being refused (the satellite provider can block requests) is reported once.
    const watch = tileWatch((b) => failedRef.current?.(b));
    const isBasemap = (id: unknown): id is Basemap => typeof id === "string" && (BASEMAP_KEYS as string[]).includes(id);
    map.on("sourcedata", (e) => {
      if (e.tile && isBasemap(e.sourceId) && e.tile.state === "loaded") watch.arrived(e.sourceId);
    });
    map.on("error", (e) => {
      const id = (e as { sourceId?: unknown }).sourceId;
      if (isBasemap(id)) watch.failed(id);
    });
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const k of BASEMAP_KEYS) {
        if (!map.getLayer(layerId(k))) continue;
        // A base map that is being kept warm is fetched like a visible one but drawn fully see-through.
        map.setLayoutProperty(layerId(k), "visibility", k === basemap || warmOthers ? "visible" : "none");
        map.setPaintProperty(layerId(k), "raster-opacity", k === basemap ? 1 : 0);
      }
    };
    // The layers exist as soon as the style is in. (Not `isStyleLoaded()`: that is false whenever
    // tiles are still on their way, which is exactly when a switch must not be lost.)
    if (map.getLayer(layerId(basemap))) apply();
    else map.once("style.load", apply);
  }, [basemap, warmOthers]);

  if (failed) {
    return (
      <div className="mp-map mp-map-failed" role="alert">
        {failed}
      </div>
    );
  }
  return <div ref={host} className="mp-map" role="region" aria-label={label} data-basemap={basemap} />;
}
