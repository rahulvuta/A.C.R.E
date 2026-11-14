import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Map as MlMap, MapGeoJSONFeature } from "maplibre-gl";
import { addHole, addParcel, bbox, checkGeometry, formatArea, type Ring } from "../farm/geometry";
import { exportFarm, exportFileName, importFarm, MAX_IMPORT_BYTES } from "../farm/geojson";
import { farmActions, useFarms } from "../farm/hooks";
import type { Farm, Field } from "../farm/types";
import { createDrawing, type Drawing } from "./drawing";
import { ensureFieldLayers, FIELDS_FILL, setFieldData, type FieldState } from "./fieldLayers";
import type { GeoApi } from "./geoApi";
import type { Pick } from "./LocationCard";
import { MapScreen } from "./MapScreen";

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
  /** Analysis state per field id (C4 colours the map with it). */
  fieldStates?: Record<string, FieldState>;
  /** Extra panel content under the field list (C4: legend, weather cells; D: open results). */
  children?: ReactNode;
  onMapReady?: (map: MlMap) => void;
  /** Rendered under the location card. Defaults to "Start a farm here". */
  pickAction?: (pick: Pick) => ReactNode;
}

export function FarmMap({ api, fieldStates, children, onMapReady, pickAction }: FarmMapProps) {
  const { farms, selectedFarm: farm, selectedFieldId, persistence, notice } = useFarms();
  const [map, setMap] = useState<MlMap | null>(null);
  const drawing = useRef<Drawing | null>(null);
  const [tool, setTool] = useState<Tool>("idle");
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // The click that closes a polygon also reaches the map; it must not drop a pin.
  const quietUntil = useRef(0);
  const selected = farm?.fields.find((f) => f.field_id === selectedFieldId) ?? null;

  const ready = useCallback(
    (m: MlMap) => {
      ensureFieldLayers(m);
      drawing.current = createDrawing(m);
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

  const stop = useCallback(() => {
    quietUntil.current = Date.now() + 400;
    drawing.current?.onFinish(null);
    drawing.current?.clear();
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
          setMessage({ kind: "info", text: `${f.name} added.` });
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
    map?.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 17, duration: 800 });
  };

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
    <MapScreen api={api} onMapReady={ready} onMapClick={onMapClick} pickAction={pickAction ?? defaultAction}>
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
      />
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
}) {
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
          <select className="input mp-farm-select" aria-label="Saved farms" value={farm?.farm_id ?? ""} onChange={(e) => farmActions.selectFarm(e.target.value)} disabled={busy}>
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

      {farm && farm.fields.length > 0 ? (
        <ul className="mp-fields" aria-label="Fields">
          {farm.fields.map((f) => {
            const a = formatArea(f.geometry);
            const isSel = f.field_id === selected?.field_id;
            return (
              <li key={f.field_id} className={isSel ? "is-selected" : undefined} data-field-id={f.field_id}>
                <button type="button" className="mp-field" aria-pressed={isSel} disabled={busy} onClick={() => farmActions.selectField(isSel ? null : f.field_id)} onDoubleClick={() => onZoom(f)}>
                  <span className="mp-field-name">{f.name}</span>
                  <span className="mp-field-area">
                    {a.ha} · {a.ac}
                  </span>
                </button>
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
        <p className="mp-quiet">{farm ? "No fields yet. Draw your first field on the map." : "Find your farm, then draw your fields."}</p>
      )}

      <div className="mp-files">
        <button type="button" className="btn btn-quiet btn-small" onClick={download} disabled={!farm || farm.fields.length === 0 || busy}>
          Export GeoJSON
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => fileInput.current?.click()} disabled={busy}>
          Import GeoJSON
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
