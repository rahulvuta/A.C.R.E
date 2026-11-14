import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import type { MapGeoApi } from "../../api/geoApi";
import type { Capabilities, LatLon, PlaceInfo } from "../../api/model";

/*
  C's map (card C1, src/map/MapScreen.tsx), loaded lazily so the planner bundle stays small
  and this file builds whether or not the map is in the checkout yet. The props are the ones
  D uses; MapScreen accepts more.
*/
export interface MapPick {
  point: LatLon;
  place: { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: PlaceInfo };
  caps: { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: Capabilities };
}
interface MapScreenLike {
  api: MapGeoApi;
  onPick?: (pick: MapPick) => void;
  pickAction?: (pick: MapPick) => ReactNode;
  children?: ReactNode;
}

const found = import.meta.glob<{ MapScreen: ComponentType<MapScreenLike> }>("../../map/MapScreen.tsx");
const loader = Object.values(found)[0];
const LazyMap = loader ? lazy(() => loader().then((m) => ({ default: m.MapScreen }))) : null;

export function MapSlot(props: MapScreenLike) {
  if (!LazyMap) {
    return (
      <div className="ws-nomap" role="status">
        The map is not part of this build yet. The Union County demo works without it.
        {props.children}
      </div>
    );
  }
  return (
    <Suspense fallback={<div className="ws-nomap" role="status">Loading the map…</div>}>
      <LazyMap {...props} />
    </Suspense>
  );
}
