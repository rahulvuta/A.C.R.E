import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { GREEN_ATTRIBUTION, GREEN_MAXZOOM, GREEN_SCALE, greenMonths, greenTiles, monthName } from "./greenLayer";
import colors from "../soil/smapColors.json";
import { newestDays, smapSpans, smapTiles, SMAP_ROOT, SMAP_ZOOM } from "../soil/smap";
import { longDate } from "../ui/units";
import { warmHosts } from "./basemap";

/** Where NASA's pictures come from. */
const NASA_HOST = "https://gibs.earthdata.nasa.gov";

/*
  NASA's pictures of the land, drawn over the satellite photo and under the field outlines:
  how green the land was in a month (card 28), and how wet the soil was on a day (card 31).
  One is shown at a time, so the grower always sees the photo's field edges on top of one
  picture and one colour scale.
*/
export const NASA_SOURCE = "nasa-picture";
export const NASA_LAYER_ID = "nasa-picture-layer";
type Kind = "green" | "soil";

const bins = colors.bins as Array<[number, number, number, number, number | null]>;
/** NASA's own colours for soil moisture, dry to wet (every 28th step of the GIBS colour map). */
export const SOIL_SCALE = bins.filter((_, i) => i % 28 === 0).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
const SOIL_ATTRIBUTION = 'Soil moisture: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noreferrer">NASA GIBS</a>, SMAP satellite with NASA\'s land model';

const PICTURES: Record<Kind, { label: string; tiles: (when: string) => string; maxzoom: number; attribution: string; whenLabel: string; whenName: (w: string) => string; scale: string[]; ends: [string, string]; scaleLabel: string; note: string; none: string }> = {
  green: {
    label: "Greenness",
    tiles: greenTiles,
    maxzoom: GREEN_MAXZOOM,
    attribution: GREEN_ATTRIBUTION,
    whenLabel: "Month",
    whenName: monthName,
    scale: GREEN_SCALE,
    ends: ["Bare", "Green"],
    scaleLabel: "Colour scale: from bare ground to dense green plants",
    note: "Plant cover from NASA's MODIS satellite. 1 km squares: the land around your field.",
    none: "NASA has no picture for this month. Pick another month.",
  },
  soil: {
    label: "Soil moisture",
    tiles: (day) => smapTiles(SMAP_ROOT, day),
    maxzoom: SMAP_ZOOM,
    attribution: SOIL_ATTRIBUTION,
    whenLabel: "Day",
    whenName: longDate,
    scale: SOIL_SCALE,
    ends: ["Dry", "Wet"],
    scaleLabel: "Colour scale: from dry soil to wet soil",
    note: "Water in the top metre of soil, from NASA's SMAP satellite and land model. 9 km squares: the land around your field, not your soil.",
    none: "NASA has no picture for this day. Pick another day.",
  },
};

function show(map: MlMap, kind: Kind, when: string) {
  hide(map);
  const p = PICTURES[kind];
  map.addSource(NASA_SOURCE, { type: "raster", tiles: [p.tiles(when)], tileSize: 256, maxzoom: p.maxzoom, attribution: p.attribution });
  // Under everything that was added after the two base maps (field outlines, labels, the drawing tool).
  const before = map.getStyle().layers.find((l) => l.id !== "background" && !l.id.startsWith("basemap-"))?.id;
  map.addLayer({ id: NASA_LAYER_ID, type: "raster", source: NASA_SOURCE, paint: { "raster-opacity": kind === "soil" ? 0.7 : 0.8, "raster-resampling": "nearest" } }, before);
}
function hide(map: MlMap) {
  if (map.getLayer(NASA_LAYER_ID)) map.removeLayer(NASA_LAYER_ID);
  if (map.getSource(NASA_SOURCE)) map.removeSource(NASA_SOURCE);
}

const soilDays = () => smapSpans(SMAP_ROOT).then((spans) => newestDays(spans, 30));

export function Greenness({ map }: { map: MlMap | null }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [whens, setWhens] = useState<Record<Kind, string[]>>({ green: [], soil: [] });
  const [when, setWhen] = useState<Record<Kind, string>>({ green: "", soil: "" });
  const [missing, setMissing] = useState(false);
  const list = kind ? whens[kind] : [];
  const chosen = kind ? when[kind] : "";

  // The list of months (or days) a picture exists for is asked for once. Reaching for a button
  // asks ahead of the click, so the picture starts loading the moment it is pressed.
  const asked = useRef<Partial<Record<Kind, boolean>>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const prime = useCallback((k: Kind) => {
    if (asked.current[k]) return;
    asked.current[k] = true;
    void (k === "green" ? greenMonths() : soilDays())
      .then((found) => {
        if (!alive.current) return;
        setWhens((w) => ({ ...w, [k]: found }));
        setWhen((w) => ({ ...w, [k]: w[k] || found[0] || "" }));
        // Nothing came back (the service did not answer): the next press asks again.
        if (!found.length) asked.current[k] = false;
      })
      .catch(() => {
        asked.current[k] = false;
      });
  }, []);
  useEffect(() => {
    if (kind) prime(kind);
  }, [kind, prime]);
  // The connection to NASA's picture service is opened as soon as the map is there.
  useEffect(() => {
    if (map) warmHosts([NASA_HOST]);
  }, [map]);

  useEffect(() => {
    if (!map) return;
    if (!kind || !chosen) {
      hide(map);
      return;
    }
    setMissing(false);
    show(map, kind, chosen);
    // A month or day NASA has no picture for answers every tile with "not found".
    const onError = (e: unknown) => {
      if ((e as { sourceId?: string }).sourceId === NASA_SOURCE) setMissing(true);
    };
    map.on("error", onError);
    return () => {
      map.off("error", onError);
    };
  }, [map, kind, chosen]);

  useEffect(() => () => {
    if (map) {
      try {
        hide(map);
      } catch {
        /* the map is already gone */
      }
    }
  }, [map]);

  const p = kind ? PICTURES[kind] : null;
  return (
    <div className="mp-green" data-on={kind ? "yes" : "no"}>
      <div className="mp-green-row" role="group" aria-label="NASA pictures of the land">
        {(Object.keys(PICTURES) as Kind[]).map((k) => (
          <button key={k} type="button" className="mp-green-toggle" aria-pressed={kind === k} onClick={() => setKind((v) => (v === k ? null : k))} onPointerEnter={() => prime(k)} onFocus={() => prime(k)} disabled={!map}>
            <span className={`mp-green-dot mp-dot-${k}`} aria-hidden="true" />
            {PICTURES[k].label}
          </button>
        ))}
      </div>
      {p && kind ? (
        <div className="mp-green-panel">
          <label>
            <span className="mp-green-label">{p.whenLabel}</span>
            <select aria-label={`${p.whenLabel} of the ${p.label.toLowerCase()} picture`} value={chosen} onChange={(e) => setWhen((w) => ({ ...w, [kind]: e.target.value }))} disabled={!list.length}>
              {list.length ? null : <option value="">Loading…</option>}
              {list.map((m) => (
                <option key={m} value={m}>
                  {p.whenName(m)}
                </option>
              ))}
            </select>
          </label>
          <div className="mp-green-scale" role="img" aria-label={p.scaleLabel}>
            <span>{p.ends[0]}</span>
            <i style={{ background: `linear-gradient(to right, ${p.scale.join(", ")})` }} />
            <span>{p.ends[1]}</span>
          </div>
          {missing ? <p className="mp-green-note" role="status">{p.none}</p> : null}
          <p className="mp-green-note">{p.note}</p>
        </div>
      ) : null}
    </div>
  );
}
