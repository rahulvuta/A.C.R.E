import type { Capabilities, Capability, CapabilityKey, PlaceInfo } from "../api/model";

/*
  What the backend knows about a picked point: place, climate class, weather cell and what
  each capability can do there. Statuses are the backend's words, shown plainly; nothing is
  judged here. A status the backend left out reads "Not reported", never as available.
*/
export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  weather: "NASA weather",
  catalog: "Crop guidance",
  soil: "Soil",
  live_weather: "Current weather",
  drought: "Drought monitor",
  tools: "Field tools",
};

export const STATUS_TEXT: Record<string, string> = {
  complete: "Available",
  partial: "Partly available",
  unavailable: "Not available",
  unknown: "Not reported",
  inapplicable: "Does not apply",
  unsupported: "Not supported here",
  invalid_input: "Point not accepted",
  manual_check: "Check by hand",
  insufficient_data: "Too little data",
};

const PROVIDER_TEXT: Record<string, string> = {
  usda_sda: "USDA soil survey",
  soilgrids: "SoilGrids model",
  nws: "US National Weather Service",
  open_meteo: "Open-Meteo",
  usdm: "US Drought Monitor",
};

const ORIGIN_NOTE: Partial<Record<string, string>> = {
  verified_source: "Published guidance",
  source_checked: "AI-found, quote checked on the source",
  ai_suggested: "AI-found suggestions, not verified",
  dataset_estimate: "Global dataset estimate",
};

function pillKind(status: string): string {
  if (status === "complete") return "ok";
  if (status === "partial" || status === "manual_check" || status === "insufficient_data") return "check";
  return "unavailable";
}

function detail(c: Capability): string | null {
  const bits: string[] = [];
  if (c.jobStatus === "pending") bits.push("Being prepared");
  if (c.provider) bits.push(PROVIDER_TEXT[c.provider] ?? c.provider);
  if (c.resolutionM != null) bits.push(`about ${c.resolutionM} m cells`);
  if (c.origin && ORIGIN_NOTE[c.origin]) bits.push(ORIGIN_NOTE[c.origin]!);
  if (c.key === "tools" && c.parts.length) bits.push(c.parts.map((p) => `${p.key}: ${(STATUS_TEXT[p.status] ?? p.status).toLowerCase()}`).join(", "));
  if (c.reasonText) bits.push(c.reasonText);
  return bits.length ? bits.join(" · ") : null;
}

/** The two things a grower needs to know about a place, in the backend's own statuses, as plain lines. */
function summary(caps: Capabilities): { key: string; tone: "ok" | "check" | "unavailable"; text: string }[] {
  const out: { key: string; tone: "ok" | "check" | "unavailable"; text: string }[] = [];
  const weather = caps.features.find((c) => c.key === "weather");
  if (weather) {
    out.push({
      key: "weather",
      tone: pillKind(weather.status) as "ok" | "check" | "unavailable",
      text: weather.jobStatus === "pending" ? "NASA weather for this place is being prepared (about a minute)." : weather.status === "complete" ? "NASA weather since 1981 is ready for this place." : weather.status === "partial" ? "NASA weather is partly available for this place." : "NASA weather is not available for this place.",
    });
  }
  const catalog = caps.features.find((c) => c.key === "catalog");
  if (catalog) {
    out.push({
      key: "catalog",
      tone: pillKind(catalog.status) as "ok" | "check" | "unavailable",
      text: catalog.status === "complete" ? "Checked local crop guidance is available here." : catalog.status === "partial" ? "No checked local guidance here yet: you get typical planting dates for the area." : "No crop guidance is available here.",
    });
  }
  return out;
}

export interface Pick {
  point: { latitude: number; longitude: number };
  place: { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: PlaceInfo };
  caps: { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: Capabilities };
}

export function LocationCard({ pick, action }: { pick: Pick; action?: React.ReactNode }) {
  const { place, caps } = pick;
  const p = place.state === "ready" ? place.data : null;
  const title = p?.display ?? (place.state === "loading" ? "Finding this place…" : "Picked point");
  const region = p ? [p.admin2Name, p.admin1Name, p.countryName].filter(Boolean).join(", ") : null;
  return (
    <section className="mp-card" aria-label="Picked place" aria-busy={place.state === "loading" || caps.state === "loading"}>
      <h2 className="mp-card-title">{title}</h2>
      {place.state === "error" ? <p className="mp-error" role="alert">{place.message}</p> : null}
      {p && p.status !== "complete" && p.reasonText ? <p className="mp-error" role="alert">{p.reasonText}</p> : null}
      {region && p && region !== p.display ? <p className="mp-region">{region}</p> : null}
      {caps.state === "loading" ? <p className="mp-quiet">Checking what is available here…</p> : null}
      {caps.state === "error" ? <p className="mp-error" role="alert">{caps.message}</p> : null}
      {caps.state === "ready" ? (
        <ul className="mp-summary" aria-label="In short">
          {summary(caps.data).map((line) => (
            <li key={line.key} data-tone={line.tone}>
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
      {action ? <div className="mp-card-action">{action}</div> : null}
      {p || caps.state === "ready" ? (
        <details className="mp-more">
          <summary>More about this place</summary>
          {p ? (
            <dl className="mp-facts">
              <dt>Climate</dt>
              <dd>{p.climate ? `${p.climate.code} · ${p.climate.label}` : "Not available"}</dd>
              <dt>Weather cell</dt>
              <dd title="One NASA POWER weather series covers a cell of about 0.5° × 0.625°.">{p.cellId ?? "Not available"}</dd>
              {p.hemisphere ? (
                <>
                  <dt>Hemisphere</dt>
                  <dd>{p.hemisphere === "south" ? "Southern" : "Northern"}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <h3 className="mp-card-sub">What A.C.R.E can use here</h3>
          {caps.state === "ready" ? (
            <ul className="mp-caps" aria-label="Capabilities">
              {caps.data.features.map((c) => {
                const d = detail(c);
                return (
                  <li key={c.key} data-capability={c.key} data-status={c.status}>
                    <span className="mp-cap-name">{CAPABILITY_LABEL[c.key]}</span>
                    <span className={`pill pill-${pillKind(c.status)}`}>{STATUS_TEXT[c.status] ?? c.status}</span>
                    {d ? <span className="mp-cap-detail">{d}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
