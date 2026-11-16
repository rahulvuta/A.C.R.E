import { useEffect, useRef, useState } from "react";
import { ORIGIN_HELP, ORIGIN_LABEL } from "../ui/OriginBadge";
import type { Origin, Source } from "./schema";
import "./inputs.css";

export const display = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "Not available" : String(value);
export const readable = (value: string) => value.replaceAll("_", " ");
export function OriginLabel({ origin }: { origin?: Origin | null }) {
  return origin ? <span className={`acre-input-origin acre-input-origin-${origin}`} data-origin={origin} title={ORIGIN_HELP[origin]}>{ORIGIN_LABEL[origin]}</span> : <span className="acre-input-muted">Not available</span>;
}
export function SourceLabel({ source }: { source?: Source | null }) {
  // No source is not worth a line of its own: the label beside the number already says "Guess".
  if (!source?.title && !source?.url) return null;
  const title = source?.title || "Source";
  return <span className="acre-input-source">Source: {source?.url && /^https?:\/\//i.test(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{title}</a> : title}{source?.years ? ` (${source.years})` : source?.year ? ` (${source.year})` : ""}</span>;
}
export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) {
  return <div className="acre-input-error" role="alert"><p>{error}</p>{retry && <button type="button" onClick={retry}>Try again</button>}</div>;
}
/**
 * A lookup that takes about a minute (cards 24 and 25): what is being looked up, how long it
 * has run against the usual time, and a way to stop. The bar fills over the usual time and
 * then keeps moving, so a slow lookup never looks stuck or finished. It is a clock, not a
 * report from the service: the sentence above it is the only statement of what is happening.
 */
export function LookupProgress({ children, usualSeconds = 60, onStop, stopLabel = "Stop" }: { children: React.ReactNode; usualSeconds?: number; onStop?: () => void; stopLabel?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const over = seconds > usualSeconds;
  return <div role="status" className="acre-input-research-status">
    <p>{children}</p>
    {onStop && <button type="button" aria-label={stopLabel} onClick={onStop}>Stop</button>}
    <div className="acre-input-lookup-meter" data-over={over ? "yes" : "no"} aria-hidden="true"><i style={{ width: `${over ? 100 : Math.max(4, Math.round((seconds / usualSeconds) * 100))}%` }} /></div>
    <small className="acre-input-lookup-time">{over ? `${seconds} seconds so far. This one is taking longer than usual; it is still looking.` : `${seconds} seconds so far. Usually about ${usualSeconds < 90 ? "a minute" : `${Math.round(usualSeconds / 60)} minutes`}.`}</small>
  </div>;
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
