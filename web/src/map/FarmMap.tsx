import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MlMap, MapGeoJSONFeature } from "maplibre-gl";
import { addHole, addParcel, areaM2, bbox, centroid, checkGeometry, farmBounds, SQ_M_PER_AC, SQ_M_PER_HA, squareAround, type Ring } from "../farm/geometry";
import { areaText, useUnits } from "../ui/units";
import { loadDemoFarm } from "../farm/demo";
import { MiniTimeline, planCrops } from "../timeline/MiniTimeline";
import { exportFarm, exportFileName, importFarm, MAX_IMPORT_BYTES } from "../farm/geojson";
import { farmActions, putFarm, useFarms } from "../farm/hooks";
import type { Farm, Field, FieldGeometry } from "../farm/types";
import { createDrawing, type Drawing } from "./drawing";
import { ensureFieldLayers, FIELDS_FILL, setFieldData, STATE_COLOR, type FieldState } from "./fieldLayers";
import { CELL_LABEL, ensureCellLayers, SHARED_NOTICE, setCellData, type WeatherCellView } from "./weatherCells";
import type { GeoApi } from "./geoApi";
import type { Pick } from "./LocationCard";
import { hasWinter } from "../ui/cropNames";
import { MapScreen } from "./MapScreen";
import type { Bounds } from "./MapView";

/*
  The farm and field editor on the map (card C2). Draw fields, add separate parcels, cut
  out areas (holes), edit corners, move, rename, delete; import and export GeoJSON. Farms are
  saved only in this browser (farm/store.ts). Areas are display measurements (turf).
*/
type Tool = "idle" | "draw-field" | "draw-parcel" | "draw-hole" | "edit";

const HINT: Record<Exclude<Tool, "idle">, string> = {
  "draw-field": "Click the map to place each corner. Click the first corner to finish. Esc cancels.",
  "draw-parcel": "Draw the separate piece that belongs to this field. Click the first corner to finish.",
  "draw-hole": "Draw the area to leave out (a pond, a building) inside the field. Click the first corner to finish.",
  edit: "Drag a corner to move it, drag the middle dot of an edge to add one, or drag the shape to move it.",
};

export interface FarmMapProps {
  api: GeoApi;
  /** Analysis state per field id (C4 colours the map with it). Fields not listed show as "not analysed". */
  fieldStates?: Record<string, FieldState>;
  /** The farm analysis' weather cells (C4): each is outlined and its fields are listed. */
  weatherCells?: WeatherCellView[];
  /** Extra panel content under the field list (C4: legend, weather cells; D: open results). */
  children?: ReactNode;
  onMapReady?: (map: MlMap) => void;
  /** Rendered under the location card. Defaults to "Start a farm here". */
  pickAction?: (pick: Pick) => ReactNode;
  /** The guided sequence: the place card's button starts drawing straight away (the farm is made when the field is finished). */
  drawOnPick?: boolean;
}

export function FarmMap({ api, fieldStates, weatherCells, children, onMapReady, pickAction, drawOnPick }: FarmMapProps) {
  const { farms, selectedFarm: farm, selectedFieldId, persistence, notice } = useFarms();
  const units = useUnits();
  const [map, setMap] = useState<MlMap | null>(null);
  // Where the map opens: on the saved farm, known before the map exists, so it never starts on the whole world and flies in.
  const [openOn] = useState<Bounds | null>(() => farmBounds(farm));
  const drawing = useRef<Drawing | null>(null);
  const [tool, setTool] = useState<Tool>("idle");
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  // The outline being drawn or edited right now, for the live acres.
  const [live, setLive] = useState<FieldGeometry | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // The click that closes a polygon also reaches the map; it must not drop a pin.
  const quietUntil = useRef(0);
  const selected = farm?.fields.find((f) => f.field_id === selectedFieldId) ?? null;

  const ready = useCallback(
    (m: MlMap) => {
      ensureCellLayers(m);
      ensureFieldLayers(m);
      drawing.current = createDrawing(m);
      drawing.current.onChange(setLive);
      setMap(m);
      onMapReady?.(m);
    },
    [onMapReady],
  );
  useEffect(() => () => drawing.current?.destroy(), []);

  // Keep the field layer in step with the store; the field being edited is drawn by terra-draw.
  useEffect(() => {
    if (map) setFieldData(map, farm, selectedFieldId, fieldStates, tool === "edit" ? selectedFieldId : null);
  }, [map, farm, selectedFieldId, fieldStates, tool]);

  // Weather cells: the outline from the backend's centre and size, and a label on each.
  const cellMarkers = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    if (!map) return;
    const cells = weatherCells ?? [];
    setCellData(map, cells);
    for (const mk of cellMarkers.current) mk.remove();
    cellMarkers.current = cells.map((c) => {
      const el = document.createElement("div");
      el.className = "mp-cell-label";
      el.dataset.cellId = c.cellId;
      el.textContent = CELL_LABEL;
      const nw: [number, number] = [c.center.longitude - c.sizeDeg[1] / 2, c.center.latitude + c.sizeDeg[0] / 2];
      return new maplibregl.Marker({ element: el, anchor: "top-left" }).setLngLat(nw).addTo(map);
    });
    return () => {
      for (const mk of cellMarkers.current) mk.remove();
      cellMarkers.current = [];
    };
  }, [map, weatherCells]);

  // Each field's name and acres on the map, at its centre; hidden when zoomed far out.
  const fieldLabels = useRef<maplibregl.Marker[]>([]);
  const pendingZoom = useRef<Farm | null>(null);
  useEffect(() => {
    if (map && pendingZoom.current) {
      const f = pendingZoom.current;
      pendingZoom.current = null;
      zoomToFarm(f);
    }
  });
  useEffect(() => {
    if (!map) return;
    for (const mk of fieldLabels.current) mk.remove();
    const editing = tool === "edit" ? selectedFieldId : null;
    fieldLabels.current = (farm?.fields ?? [])
      .filter((f) => f.field_id !== editing)
      .map((f) => {
        const el = document.createElement("div");
        el.className = "mp-field-label";
        el.dataset.fieldId = f.field_id;
        const a = areaText(areaM2(f.geometry), units);
        const name = document.createElement("strong");
        name.textContent = f.name;
        name.setAttribute("translate", "no");
        const ac = document.createElement("span");
        ac.textContent = `${a.main} · ${a.other}${f.approx_shape ? " · approximate shape" : ""}`;
        el.append(name, ac);
        const c = centroid(f.geometry);
        return new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([c.longitude, c.latitude]).addTo(map);
      });
    const host = map.getContainer();
    const zoomed = () => host.classList.toggle("mp-labels-off", map.getZoom() < 12);
    zoomed();
    map.on("zoomend", zoomed);
    return () => {
      map.off("zoomend", zoomed);
      for (const mk of fieldLabels.current) mk.remove();
      fieldLabels.current = [];
    };
  }, [map, farm, tool, selectedFieldId, units]);

  const zoomToFarm = useCallback(
    (f: Farm) => {
      if (f.fields.length === 0) return;
      // Chosen before the map finished loading: zoom once it is ready.
      if (!map) {
        pendingZoom.current = f;
        return;
      }
      const [w, s2, e, n] = farmBounds(f)!;
      // Straight there: a flight would fetch tiles all along the way before the farm's own.
      map.fitBounds([[w, s2], [e, n]], { padding: 80, maxZoom: 16, duration: 0 });
    },
    [map],
  );
  // A grower who comes back to the map sees their own fields, not the whole world: the first
  // time the map is ready, it opens on the saved farm. Later edits never move the map.
  const openedOnFarm = useRef(openOn !== null);
  useEffect(() => {
    if (!map || openedOnFarm.current) return;
    openedOnFarm.current = true;
    if (farm && farm.fields.length > 0) zoomToFarm(farm);
  }, [map, farm, zoomToFarm]);

  const loadDemo = useCallback(async () => {
    setMessage({ kind: "info", text: "Loading the demo farm…" });
    const r = await loadDemoFarm("union", api.demoFarm ? (sc, sig) => api.demoFarm!(sc, sig) : undefined);
    if (!r.ok) return setMessage({ kind: "error", text: r.message });
    putFarm({ ...r.demo.farm, demo: r.demo.label });
    zoomToFarm(r.demo.farm);
    setMessage({ kind: "info", text: `${r.demo.label}: ${r.demo.farm.fields.length} fields loaded.${r.demo.source === "example" ? " These are example values, not a real farm." : ""}` });
  }, [api, zoomToFarm]);

  const stop = useCallback(() => {
    quietUntil.current = Date.now() + 400;
    drawing.current?.onFinish(null);
    drawing.current?.clear();
    setLive(null);
    setTool("idle");
  }, []);

  // Esc leaves any tool.
  useEffect(() => {
    if (tool === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, stop]);

  const ensureFarm = useCallback((): Farm => {
    if (farm) return farm;
    const c = map?.getCenter();
    return farmActions.createFarm("My farm", { latitude: c?.lat ?? 0, longitude: c?.lng ?? 0 });
  }, [farm, map]);

  const startDraw = (t: "draw-field" | "draw-parcel" | "draw-hole") => {
    const d = drawing.current;
    if (!d) return;
    setMessage(null);
    d.clear();
    d.onFinish((ring: Ring) => {
      try {
        if (t === "draw-field") {
          const g = { type: "Polygon" as const, coordinates: [ring] };
          const problem = checkGeometry(g);
          if (problem) throw new Error(problem.message);
          const target = ensureFarm();
          const f = farmActions.addField(target.farm_id, g);
          // A field drawn while zoomed far out comes out far too large; say so instead of saving it silently.
          const m2 = areaM2(g);
          setMessage({ kind: "info", text: m2 > LARGE_FIELD_M2 ? `${f.name} added. It is ${areaText(m2).main} (${areaText(m2).other}), which is large for one field. If that is not right, zoom in and press Edit shape.` : `${f.name} added.` });
        } else if (selected) {
          const r = t === "draw-parcel" ? addParcel(selected.geometry, ring) : addHole(selected.geometry, ring);
          if (!r.ok) throw new Error(r.message);
          farmActions.updateField(selected.field_id, { geometry: r.geometry });
        }
      } catch (err) {
        setMessage({ kind: "error", text: (err as Error).message });
      }
      stop();
    });
    d.setMode("polygon");
    setTool(t);
  };

  const startEdit = () => {
    if (!selected || !drawing.current) return;
    setMessage(null);
    drawing.current.loadForEdit(selected.geometry);
    setLive(selected.geometry);
    setTool("edit");
  };

  const finishEdit = () => {
    if (!selected || !drawing.current) return;
    const g = drawing.current.collectEdit();
    const problem = g ? checkGeometry(g) : { message: "The field has no outline left." };
    if (problem || !g) {
      setMessage({ kind: "error", text: `${problem!.message} Fix it, or cancel to keep the old shape.` });
      return;
    }
    farmActions.updateField(selected.field_id, { geometry: g });
    stop();
  };

  // Clicks on a saved field select it; while a tool is on, clicks belong to the tool.
  const onMapClick = useCallback(
    (_p: unknown, screen: { x: number; y: number }) => {
      if (toolRef.current !== "idle" || Date.now() < quietUntil.current) return true;
      if (!map || !map.getLayer(FIELDS_FILL)) return false;
      const hit: MapGeoJSONFeature | undefined = map.queryRenderedFeatures([screen.x, screen.y], { layers: [FIELDS_FILL] })[0];
      const id = hit?.properties?.field_id as string | undefined;
      if (!id) return false;
      farmActions.selectField(id);
      return true;
    },
    [map],
  );

  const zoomTo = (f: Field) => {
    const [w, s, e, n] = bbox(f.geometry);
    map?.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 17, duration: 250 });
  };

  /** The second way in (card 17): a square of the typed size around the pin, marked as an approximate shape. */
  const addBySize = (pick: Pick, m2: number) => {
    try {
      const g = squareAround(pick.point, m2);
      const target = ensureFarm();
      const f = farmActions.addField(target.farm_id, g, undefined, true);
      const [w, s, e, n] = bbox(g);
      map?.fitBounds([[w, s], [e, n]], { padding: 120, maxZoom: 17, duration: 250 });
      setMessage({ kind: "info", text: `${f.name} added as a square of ${areaText(m2).main} around your pin. Its shape is approximate: press Edit shape to trace the real edge whenever you like.` });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "That field could not be added." });
    }
  };
  const drawAction = (pick: Pick) =>
    tool === "idle" ? (
      <>
        <button type="button" className="btn btn-primary" onClick={() => startDraw("draw-field")}>
          Draw my field here
        </button>
        <SizeEntry onAdd={(m2) => addBySize(pick, m2)} />
      </>
    ) : null;
  const defaultAction = (pick: Pick) => (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={() => {
        const name = pick.place.state === "ready" && pick.place.data.admin2Name ? `Farm near ${pick.place.data.admin2Name}` : "My farm";
        farmActions.createFarm(name, pick.point);
        setMessage({ kind: "info", text: "Farm started. Draw your first field." });
      }}
    >
      Start a farm here
    </button>
  );

  return (
    <MapScreen api={api} onMapReady={ready} initialBounds={openOn} onMapClick={onMapClick} pickAction={pickAction ?? (drawOnPick ? drawAction : defaultAction)}>
      <FarmPanel
        farms={farms}
        farm={farm}
        selected={selected}
        tool={tool}
        message={message}
        storageNote={persistence === "memory" || notice ? notice : null}
        onTool={(t) => (t === "edit" ? startEdit() : startDraw(t))}
        onDone={finishEdit}
        onCancel={() => {
          stop();
          setMessage(null);
        }}
        onZoom={zoomTo}
        onMessage={setMessage}
        onDemo={loadDemo}
        fieldStates={fieldStates}
        live={live}
      />
      {farm && farm.fields.length > 0 ? <ResultsLegend farm={farm} states={fieldStates} cells={weatherCells} /> : null}
      {children}
    </MapScreen>
  );
}

function FarmPanel({
  farms,
  farm,
  selected,
  tool,
  message,
  storageNote,
  onTool,
  onDone,
  onCancel,
  onZoom,
  onMessage,
  onDemo,
  fieldStates = {},
  live,
}: {
  farms: Farm[];
  farm: Farm | null;
  selected: Field | null;
  tool: Tool;
  message: { kind: "error" | "info"; text: string } | null;
  storageNote: string | null;
  onTool: (t: Exclude<Tool, "idle">) => void;
  onDone: () => void;
  onCancel: () => void;
  onZoom: (f: Field) => void;
  onMessage: (m: { kind: "error" | "info"; text: string } | null) => void;
  onDemo: () => void;
  fieldStates?: Record<string, FieldState>;
  live: FieldGeometry | null;
}) {
  // Sizes for display only, in the grower's unit first; the backend recomputes area for analysis.
  const units = useUnits();
  const liveM2 = live ? areaM2(live) : null;
  const fieldsM2 = (farm?.fields ?? []).reduce((t, f) => t + (tool === "edit" && f.field_id === selected?.field_id ? 0 : areaM2(f.geometry)), 0);
  const totalM2 = fieldsM2 + (liveM2 !== null && (tool === "draw-field" || tool === "edit") ? liveM2 : 0);
  const fieldCount = (farm?.fields.length ?? 0) + (tool === "draw-field" && liveM2 ? 1 : 0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const busy = tool !== "idle";

  const download = () => {
    if (!farm) return;
    const blob = new Blob([JSON.stringify(exportFarm(farm), null, 2)], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName(farm);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return onMessage({ kind: "error", text: "The file is larger than 5 MB." });
    const r = importFarm(await file.text(), file.name.replace(/\.(geo)?json$/i, "") || "Imported farm");
    if (!r.ok) return onMessage({ kind: "error", text: `Nothing was imported. ${r.problems.slice(0, 5).join(" ")}${r.problems.length > 5 ? ` (${r.problems.length - 5} more problems)` : ""}` });
    farmActions.addFarm(r.farm);
    onMessage({ kind: "info", text: `Imported ${r.farm.fields.length} ${r.farm.fields.length === 1 ? "field" : "fields"} as “${r.farm.name}”.` });
  };

  return (
    <section className="mp-farm" aria-label="Your farm">
      <div className="mp-farm-head">
        {farm ? (
          <input
            key={farm.farm_id}
            className="input mp-farm-name"
            aria-label="Farm name"
            defaultValue={farm.name}
            onBlur={(e) => farmActions.renameFarm(farm.farm_id, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h2 className="mp-card-title">Your farm</h2>
        )}
        {farms.length > 1 ? (
          <select className="input mp-farm-select" aria-label="Saved farms" translate="no" value={farm?.farm_id ?? ""} onChange={(e) => farmActions.selectFarm(e.target.value)} disabled={busy}>
            {farms.map((f) => (
              <option key={f.farm_id} value={f.farm_id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {tool === "idle" ? (
        <div className="mp-tools" role="toolbar" aria-label="Drawing tools">
          <button type="button" className="btn btn-primary btn-small" onClick={() => onTool("draw-field")}>
            Draw a field
          </button>
          {selected ? (
            <>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => onTool("edit")}>
                Edit shape
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => onTool("draw-hole")}>
                Cut out an area
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => onTool("draw-parcel")}>
                Add a separate piece
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <div className="mp-drawing" role="status">
          <p>{HINT[tool]}</p>
          <p className="mp-live" aria-live="polite">
            {liveM2 !== null ? (
              <>
                {tool === "draw-hole" ? "Area left out: " : "This shape: "}
                <strong>{areaText(liveM2, units).main}</strong> · {areaText(liveM2, units).other}
              </>
            ) : (
              "Place at least three corners to see the size."
            )}
          </p>
          <div className="mp-tools">
            {tool === "edit" ? (
              <button type="button" className="btn btn-primary btn-small" onClick={onDone}>
                Done
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {message ? (
        <p className={message.kind === "error" ? "mp-error" : "mp-quiet"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      {farm && fieldCount > 0 ? (
        <div className="mp-total" aria-live="polite" data-testid="farm-total">
          <span className="mp-total-label">Farm total</span>
          <span className="mp-total-ac">{areaText(totalM2, units).main}</span>
          <span className="mp-total-sub">
            {areaText(totalM2, units).other} · {fieldCount} {fieldCount === 1 ? "field" : "fields"}
          </span>
        </div>
      ) : null}

      {farm && farm.fields.length > 0 ? (
        <ul className="mp-fields" aria-label="Fields">
          {farm.fields.map((f) => {
            const a = areaText(areaM2(f.geometry), units);
            const isSel = f.field_id === selected?.field_id;
            return (
              <li key={f.field_id} className={isSel ? "is-selected" : undefined} data-field-id={f.field_id}>
                <button type="button" className="mp-field" aria-pressed={isSel} disabled={busy} onClick={() => farmActions.selectField(isSel ? null : f.field_id)} onDoubleClick={() => onZoom(f)}>
                  <span className="mp-field-top">
                    <span className="mp-field-name">
                      <span translate="no">{f.name}</span>
                      {f.approx_shape ? <span className="mp-approx">Approximate shape</span> : null}
                    </span>
                    <span className="mp-field-area">
                      <strong>{a.main}</strong> {a.other}
                    </span>
                  </span>
                  <span className="mp-field-crops">{planCrops(f.plan, hasWinter(centroid(f.geometry).latitude))}</span>
                  {/* A status line only when there is something to tell: a result, or one being prepared. */}
                  {f.plan && (fieldStates[f.field_id] ?? "none") !== "none" ? (
                    <span className="mp-field-status" data-state={fieldStates[f.field_id]}>
                      <span className="mp-dot" style={{ background: STATE_COLOR[fieldStates[f.field_id]!] }} aria-hidden="true" />
                      {PLAN_STATUS[fieldStates[f.field_id]!]}
                    </span>
                  ) : null}
                </button>
                {f.plan ? (
                  <div className="mp-field-mini">
                    <MiniTimeline plan={f.plan} />
                  </div>
                ) : null}
                {isSel && !busy ? (
                  <div className="mp-field-edit">
                    <input
                      key={f.field_id + f.name}
                      className="input"
                      aria-label="Field name"
                      defaultValue={f.name}
                      onBlur={(e) => farmActions.updateField(f.field_id, { name: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => onZoom(f)}>
                      Zoom to
                    </button>
                    {confirmDelete === f.field_id ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => {
                          farmActions.deleteField(f.field_id);
                          setConfirmDelete(null);
                        }}
                      >
                        Delete {f.name}?
                      </button>
                    ) : (
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirmDelete(f.field_id)}>
                        Delete
                      </button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mp-empty">
          <p className="mp-quiet">{farm ? "No fields yet. Draw your first field on the map." : "Find your farm, then draw your fields."}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={onDemo} disabled={busy}>
            Try an example farm
          </button>
        </div>
      )}

      <div className="mp-files">
        <button type="button" className="btn btn-quiet btn-small" onClick={download} disabled={!farm || farm.fields.length === 0 || busy}>
          Save a copy of my fields
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => fileInput.current?.click()} disabled={busy}>
          Load a saved copy
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          aria-label="GeoJSON file to import"
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <p className="mp-fine">{storageNote ?? "Saved in this browser only. Nothing is sent until you run an analysis."}</p>
    </section>
  );
}

const STATE_LABEL: Record<FieldState, string> = {
  none: "Not analysed yet",
  pending: "Weather being prepared",
  ready: "Results ready",
  flagged: "Has a check to look at",
  unavailable: "No result here",
};

/** Legend for the field colours, and which fields share each NASA weather cell (card C4). */
function ResultsLegend({ farm, states = {}, cells = [] }: { farm: Farm; states?: Record<string, FieldState>; cells?: WeatherCellView[] }) {
  const used = new Set<FieldState>(farm.fields.map((f) => states[f.field_id] ?? "none"));
  const name = (id: string) => farm.fields.find((f) => f.field_id === id)?.name ?? "A field not on this farm";
  return (
    <section className="mp-results-layer" aria-label="Map key">
      <ul className="mp-legend" aria-label="Field colours">
        {(Object.keys(STATE_LABEL) as FieldState[])
          .filter((k) => used.has(k))
          .map((k) => (
            <li key={k} data-state={k}>
              <span className="mp-swatch" style={{ background: STATE_COLOR[k] }} aria-hidden="true" />
              {STATE_LABEL[k]}
            </li>
          ))}
      </ul>
      {cells.length > 0 ? (
        <ul className="mp-cells" aria-label="Weather cells">
          {cells.map((c) => (
            <li key={c.cellId} data-cell-id={c.cellId}>
              <p className="mp-cell-title">One NASA weather series</p>
              <p className="mp-quiet">{c.fieldIds.map(name).join(", ")}</p>
              {c.fieldIds.length >= 2 ? <p className="mp-fine">{c.note || SHARED_NOTICE}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Above this a single drawn shape is probably a zoom mistake: 200 hectares, about 500 acres. */
const LARGE_FIELD_M2 = 200 * SQ_M_PER_HA;

/** "I know its size": type the size and the field is added as a square around the pin, with no drawing. */
function SizeEntry({ onAdd }: { onAdd: (m2: number) => void }) {
  const units = useUnits();
  const [text, setText] = useState("");
  const size = Number(text);
  const ok = text.trim() !== "" && Number.isFinite(size) && size > 0;
  const m2 = size * (units.area === "ha" ? SQ_M_PER_HA : SQ_M_PER_AC);
  return (
    <form
      className="mp-size"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onAdd(m2);
      }}
    >
      <label>
        <span>Or type its size</span>
        <span className="mp-size-row">
          <input type="number" inputMode="decimal" min="0" step="any" value={text} onChange={(e) => setText(e.target.value)} aria-label={`Field size in ${units.area === "ha" ? "hectares" : "acres"}`} placeholder="Size" />
          <span className="mp-size-unit">{units.area === "ha" ? "hectares" : "acres"}</span>
          <button type="submit" className="btn btn-secondary" disabled={!ok}>
            Add field
          </button>
        </span>
      </label>
      {ok && m2 > LARGE_FIELD_M2 ? <small className="mp-size-note">That is large for one field. Check the number and the unit.</small> : null}
    </form>
  );
}

/** A field card's one-line plan status. */
const PLAN_STATUS: Record<FieldState, string> = {
  none: "Plan set, not simulated yet",
  pending: "Weather being prepared",
  ready: "Results ready",
  flagged: "Results ready, with a check",
  unavailable: "No result here",
};
