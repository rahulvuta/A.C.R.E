import { useEffect, useState } from "react";
import type { SimState } from "../state/useSimulation";
import { Banner } from "./components";
import { longDate } from "./units";

/*
  What a grower sees on a weak connection (card 20): a plain line when the device is offline,
  and, where a result could not be fetched, the last one kept on the device with its date and
  a way to try again. Nothing typed is lost either way: answers are saved as they are entered.
*/
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function OfflineNote() {
  const online = useOnline();
  if (online) return null;
  return (
    <Banner kind="info">
      <strong>You are offline.</strong> Your fields, your answers and the last results for each field are saved on this device. New results need a connection.
    </Banner>
  );
}

/** Shown in place of a fresh result that could not be fetched. */
export function SavedNotice({ sim, onRetry }: { sim: SimState; onRetry: () => void }) {
  if (sim.state !== "ready" || !sim.saved) return null;
  return (
    <Banner kind="info">
      <strong>The service could not be reached.</strong> This is your last saved result, from <time dateTime={sim.saved.at}>{longDate(sim.saved.at)}</time>
      {sim.saved.sameInputs ? "." : ". Your answers have changed since then, so it may not match them."}{" "}
      <button type="button" className="btn btn-quiet" onClick={onRetry}>
        Try again
      </button>
    </Banner>
  );
}
