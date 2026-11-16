import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { BASEMAP_KEYS, baseStyle, layerId, type Basemap } from "./basemap";
import type { LatLon } from "../api/model";

/*
  The MapLibre map: satellite and streets basemaps, zoom buttons, a scale bar and an
  attribution line that is always expanded. Other parts (the pin, drawing, results layer)
  get the live map through `onReady`. The view's centre and zoom are mirrored onto the
  container as data attributes so tests can read where the map went.
*/
// MapLibre finds its worker next to its own module, which Vite's bundling moves; point at it.
maplibregl.setWorkerUrl(workerUrl);

export interface MapViewProps {
  initialCenter?: LatLon;
  initialZoom?: number;
  basemap: Basemap;
  /** A map click that is not handled by a drawing tool. */
  onClick?: (p: LatLon, screen: { x: number; y: number }) => void;
  onReady?: (map: MlMap) => void;
  label?: string;
}

export function MapView({ initialCenter = { latitude: 20, longitude: 0 }, initialZoom = 1.6, basemap, onClick, onReady, label = "Map" }: MapViewProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let map: MlMap;
    try {
      map = new maplibregl.Map({
        container: host.current,
        style: baseStyle(basemap),
        center: [initialCenter.longitude, initialCenter.latitude],
        zoom: initialZoom,
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
    map.on("load", () => {
      el.dataset.ready = "true";
      onReady?.(map);
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
        if (map.getLayer(layerId(k))) map.setLayoutProperty(layerId(k), "visibility", k === basemap ? "visible" : "none");
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [basemap]);

  if (failed) {
    return (
      <div className="mp-map mp-map-failed" role="alert">
        {failed}
      </div>
    );
  }
  return <div ref={host} className="mp-map" role="region" aria-label={label} data-basemap={basemap} />;
}
