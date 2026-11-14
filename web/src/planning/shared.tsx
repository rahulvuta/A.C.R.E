import { useEffect, useState } from "react";
import { ZodError } from "zod";
import { fetchHistoricalReplay, type Indicator, type Origin, type ReplayRequest, type Source, type Vulnerability } from "./api";
export const readable = (s: string) => s.replaceAll("_", " ");
export function OriginBadge({
  origin
}: {
  origin?: Origin | "generated";
}) {
  return <span className={`pl-origin pl-origin-${origin ?? "unknown"}`} data-origin={origin ?? "unknown"}>{origin ?? "unknown"}</span>;
}
export function SourceLink({
  source
}: {
  source?: Source | null;
}) {
  if (!source?.title) return null;
  const safeUrl = source.url && /^https?:\/\//i.test(source.url) ? source.url : null;
  return safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer">{source.title}</a> : <span>{source.title}</span>;
}
export const formatValue = (value: unknown): string => value === null || value === undefined ? "Not available" : typeof value === "object" ? JSON.stringify(value) : String(value);
export function IndicatorValue({
  indicator
}: {
  indicator?: Indicator;
}) {
  if (!indicator) return <span className="pl-muted">Not available</span>;
  return <><span className="pl-value">{formatValue(indicator.value)}</span>{indicator.value !== null && <small>{indicator.unit}</small>}{indicator.status !== "complete" && <small>{readable(indicator.status)}{indicator.reason ? `: ${indicator.reason}` : ""}</small>}</>;
}
export function Vulnerabilities({
  items,
  onReplay
}: {
  items: Vulnerability[];
  onReplay?: (request: ReplayRequest) => void;
}) {
  return items.length ? <ul className="pl-evidence-list">{items.map((item, i) => <li key={`${item.year}-${i}`}><span>{item.text}</span>{item.replay && (onReplay ? <button className="pl-text-button" onClick={() => onReplay(item.replay!)}>Replay {item.year}</button> : <InlineReplay request={item.replay} year={String(item.year)} />)}</li>)}</ul> : <p className="pl-muted">No historical vulnerabilities returned.</p>;
}
function InlineReplay({
  request,
  year
}: {
  request: ReplayRequest;
  year: string;
}) {
  const [open, setOpen] = useState(false);
  return <div><button className="pl-text-button" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? "Close replay" : `Replay ${year}`}</button>{open && <HistoricalReplay request={request} />}</div>;
}
function HistoricalReplay({
  request
}: {
  request: ReplayRequest;
}) {
  const {
    data,
    error,
    loading,
    retry
  } = usePlanningRequest(JSON.stringify(request), signal => fetchHistoricalReplay(request, signal));
  if (loading) return <p role="status">Loading this past season…</p>;
  if (error) return <RequestError message={error} onRetry={retry} />;
  if (!data) return null;
  return <section className="pl-inline-replay" aria-label="Historical replay"><h4>Recorded season {data.year ?? "Not available"}</h4>{data.reason_text && <p>{data.reason_text}</p>}{data.status && <p>Status: {readable(data.status)}</p>}<dl>{data.winter && <><dt>Rain outside planned cover</dt><dd>{formatValue(data.winter.rain_outside_cover_mm)}{data.winter.rain_outside_cover_mm != null && " mm"}<OriginBadge origin="calculation" /></dd><dt>Living cover</dt><dd>{formatValue(data.winter.living_cover_days)}{data.winter.living_cover_days != null && " planned days"}<OriginBadge origin="calculation" /></dd><dt>Off-season evidence</dt><dd>{data.winter.status}</dd></>}{data.spring && <><dt>Rain in the 30 days before planting</dt><dd>{formatValue(data.spring.total_mm)}{data.spring.total_mm != null && " mm"}<OriginBadge origin="calculation" /></dd><dt>Pre-plant evidence</dt><dd>{data.spring.status}</dd></>}</dl>{data.checks_triggered.map((check, i) => <div key={i}><p>{check.reason}</p><SourceLink source={check.source} /></div>)}</section>;
}
export function usePlanningRequest<T>(key: string, loader: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: string;
    loading: boolean;
  }>({
    key,
    loading: true
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({
      key,
      loading: true
    });
    Promise.resolve().then(() => loader(controller.signal)).then(data => {
      if (!controller.signal.aborted) setState({
        key,
        data,
        loading: false
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({
        key,
        error: error instanceof ZodError ? error.issues.map(issue => `${issue.path.map(String).map(readable).join(" · ")}: ${issue.message}`).join(" ") : error instanceof Error ? error.message : "The planning service could not be reached.",
        loading: false
      });
    });
    return () => controller.abort();
    // The serialized request is the dependency, so parent object identity never triggers a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  const current: {
    data?: T;
    error?: string;
    loading: boolean;
  } = state.key === key ? state : {
    loading: true
  };
  return {
    ...current,
    retry: () => setAttempt(n => n + 1)
  };
}
export function RequestError({
  message,
  onRetry
}: {
  message: string;
  onRetry: () => void;
}) {
  return <div className="pl-card pl-error" role="alert"><p>{message}</p><button className="pl-button" onClick={onRetry}>Try again</button></div>;
}
