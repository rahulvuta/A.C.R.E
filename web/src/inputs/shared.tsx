import { useEffect, useState } from "react";
import type { Origin, Source } from "./schema";
import "./inputs.css";

export const display = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "Not available" : String(value);
export const readable = (value: string) => value.replaceAll("_", " ");
export function OriginLabel({ origin }: { origin?: Origin }) {
  return origin ? <span className={`acre-input-origin acre-input-origin-${origin}`} data-origin={origin}>{origin}</span> : <span className="acre-input-muted">Not available</span>;
}
export function SourceLabel({ source }: { source?: Source | null }) {
  const title = source?.title || "Not available";
  return <span className="acre-input-source">Source: {source?.url && /^https?:\/\//i.test(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{title}</a> : title}{source?.years ? ` (${source.years})` : source?.year ? ` (${source.year})` : ""}</span>;
}
export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) {
  return <div className="acre-input-error" role="alert"><p>{error}</p>{retry && <button type="button" onClick={retry}>Try again</button>}</div>;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : "The service could not be reached. Your entries are still here.";
export function useInputRequest<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: enabled });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, loading: enabled });
    if (enabled) Promise.resolve().then(() => load(controller.signal)).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ key, error: errorText(error), loading: false });
    });
    return () => controller.abort();
    // Callers serialize all request inputs in key; object identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, enabled, load]);
  const current: { data?: T; error?: string; loading: boolean } = state.key === key ? state : { loading: enabled };
  return { ...current, retry: () => setAttempt(n => n + 1) };
}
