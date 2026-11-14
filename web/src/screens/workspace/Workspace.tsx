import { useState } from "react";
import { APP_NAME } from "../../config";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { Banner } from "../../ui/components";
import { navIcon } from "../planner/SideNav";
import { MapSlot, type MapPick } from "./MapSlot";

/*
  The global entry (card D1): find the farm on the map, see what A.C.R.E can use there.
  The Union County demo sits next to the map and still opens offline from the saved record.
*/

export const DEMO_HREF = "?view=demo";

export function DemoLink({ className = "btn" }: { className?: string }) {
  return (
    <a className={className} href={DEMO_HREF}>
      Open the Union County demo
    </a>
  );
}

export function SourceBanner({ source }: { source: GlobalApi["source"] }) {
  if (source === "fixtures")
    return (
      <Banner kind="synthetic">
        <strong>Sample responses.</strong> Made-up answers for trying the screens; not NASA data and not your place.
      </Banner>
    );
  if (source === "none")
    return (
      <Banner kind="info">
        Finding a farm needs the A.C.R.E service, which is not connected in this build. The Union County demo works offline.
      </Banner>
    );
  return null;
}

export function Workspace({ api: given }: { api?: GlobalApi }) {
  const fallback = useGlobalApi();
  const api = given ?? fallback;
  const [pick, setPick] = useState<MapPick | null>(null);

  return (
    <div className="db ws">
      <aside className="db-side">
        <a className="db-brand" href="./" aria-label={`${APP_NAME} home`}>
          <span className="fb-mark" aria-hidden="true" />
          {APP_NAME}
        </a>
        <nav className="db-nav" aria-label="Pages">
          <button type="button" aria-current="page">
            {navIcon("M9 16s5-4.500 5-8.500a5 5 0 0 0-10 0C4 11.500 9 16 9 16zM9 9.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4z")}
            Find your farm
          </button>
        </nav>
        <div className="db-side-foot">
          <div className="db-links">
            <a href={DEMO_HREF}>
              {navIcon("M3 8l6-5 6 5v7H3zM7.5 15v-4h3v4")}
              Union County demo
            </a>
            <a href="?view=methods">{navIcon("M9 16A7 7 0 1 0 9 2a7 7 0 0 0 0 14zM7 7a2 2 0 1 1 3 1.700c-.600.400-1 .800-1 1.500M9 12.700v.100")}How it works</a>
            <a href="?view=privacy">{navIcon("M9 2l5.500 2v4.500c0 3.500-2.300 6-5.500 7.500-3.200-1.500-5.500-4-5.500-7.500V4zM6.700 9l1.700 1.700 3-3.200")}Privacy and terms</a>
          </div>
        </div>
      </aside>
      <div className="db-body">
        <header className="db-top">
          <div className="db-crumbs">
            <h1>Find your farm</h1>
          </div>
          <div className="db-top-actions">
            <DemoLink />
          </div>
        </header>
        <main className="db-main ws-main">
          <SourceBanner source={api.source} />
          <div className="ws-map" data-picked={pick ? "yes" : "no"}>
            <MapSlot api={api.geo} onPick={setPick} />
          </div>
        </main>
      </div>
    </div>
  );
}
