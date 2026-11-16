import { useEffect, useRef, useState } from "react";
import { ORIGIN_LABEL } from "../ui/OriginBadge";
import type { Origin, Source } from "./schema";
import "./inputs.css";

export const display = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "Not available" : String(value);
export const readable = (value: string) => value.replaceAll("_", " ");
export function OriginLabel({ origin }: { origin?: Origin | null }) {
  return origin ? <span className={`acre-input-origin acre-input-origin-${origin}`} data-origin={origin}>{ORIGIN_LABEL[origin]}</span> : <span className="acre-input-muted">Not available</span>;
}
export function SourceLabel({ source }: { source?: Source | null }) {
  const title = source?.title || "Not available";
  return <span className="acre-input-source">Source: {source?.url && /^https?:\/\//i.test(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{title}</a> : title}{source?.years ? ` (${source.years})` : source?.year ? ` (${source.year})` : ""}</span>;
}
export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) {
  return <div className="acre-input-error" role="alert"><p>{error}</p>{retry && <button type="button" onClick={retry}>Try again</button>}</div>;
}
/** Wait `ms`, rejecting with an AbortError as soon as `signal` aborts (used between checks on a running lookup). */
export function pauseFor(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : "The service could not be reached. Your entries are still here.";
export function useInputRequest<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean; refreshing?: boolean }>({ key, loading: enabled });
  const [attempt, setAttempt] = useState(0);
  const quiet = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const silent = quiet.current; quiet.current = false;
    if (!silent) setState({ key, loading: enabled });
    if (enabled) Promise.resolve().then(() => load(controller.signal)).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      // A quiet refresh that fails keeps what is already on screen.
      setState(previous => silent && previous.key === key && previous.data !== undefined ? { ...previous, refreshing: false } : { key, error: errorText(error), loading: false });
    });
    return () => controller.abort();
    // Callers serialize all request inputs in key; object identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, enabled, load]);
  const current: { data?: T; error?: string; loading: boolean; refreshing?: boolean } = state.key === key ? state : { loading: enabled };
  return {
    ...current, refreshing: !!current.refreshing, retry: () => setAttempt(n => n + 1),
    /** Fetch again without clearing what is on screen. */
    refresh: () => { quiet.current = true; setState(previous => ({ ...previous, refreshing: true })); setAttempt(n => n + 1); },
  };
}
