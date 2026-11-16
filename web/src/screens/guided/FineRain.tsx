import { useEffect, useState } from "react";
import { API_BASE } from "../../config";
import { OriginBadge } from "../../ui/OriginBadge";
import { LOCALE, rainText } from "../../ui/units";

/*
  Rain closer to the field (card 30). The 10-year outlook uses one rain record for an area about
  50 km across. NASA's GPM IMERG satellite record is on squares about 10 km across. This card
  sets the two side by side for the field's own square, year by year. It is a second look at
  the same place: it changes no result, and says so.
*/
interface FineYear {
  year: number;
  fine_mm: number;
  coarse_mm: number | null;
}
export interface FineRainDoc {
  status: string;
  reason_text?: string | null;
  years: FineYear[];
  summary: { years: number; first_year: number; last_year: number; fine_mean_mm: number; coarse_mean_mm: number | null; difference_pct: number | null; years_fine_lower: number | null } | null;
}

const asked = new Map<string, Promise<FineRainDoc | null>>();
/** Asked once per 10 km square per visit. */
export function fineRain(point: { latitude: number; longitude: number }, fetcher: typeof fetch = fetch): Promise<FineRainDoc | null> {
  if (!API_BASE) return Promise.resolve(null);
  const key = `${Math.floor(point.latitude * 10)}|${Math.floor(point.longitude * 10)}`;
  let hit = asked.get(key);
  if (!hit) {
    hit = fetcher(`${API_BASE.replace(/\/$/, "")}/v1/weather/fine-rain`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ latitude: point.latitude, longitude: point.longitude }) })
      .then((r) => (r.ok ? (r.json() as Promise<FineRainDoc>) : null))
      .catch(() => null);
    asked.set(key, hit);
    void hit.then((doc) => {
      if (!doc || doc.status === "unavailable") asked.delete(key);
    });
  }
  return hit;
}
export function resetFineRainForTests() {
  asked.clear();
}

/** "about 23% drier", "about 14% wetter", or "about the same" inside 5%. */
export function differenceWords(pct: number | null): string | null {
  if (pct == null) return null;
  if (Math.abs(pct) < 5) return "about the same";
  return `about ${Math.abs(Math.round(pct)).toLocaleString(LOCALE)}% ${pct < 0 ? "drier" : "wetter"}`;
}

const W = 360;
const H = 120;
function Lines({ years }: { years: FineYear[] }) {
  const all = years.flatMap((y) => [y.fine_mm, ...(y.coarse_mm != null ? [y.coarse_mm] : [])]);
  const top = Math.max(...all) * 1.08;
  const x = (i: number) => 8 + (i * (W - 16)) / Math.max(1, years.length - 1);
  const y = (v: number) => H - 18 - (v / top) * (H - 30);
  const path = (get: (r: FineYear) => number | null) => {
    let d = "";
    let pen = false;
    years.forEach((r, i) => {
      const v = get(r);
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const first = years[0]!.year;
  const last = years[years.length - 1]!.year;
  return (
    <svg className="fr-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rain each year from ${first} to ${last}: the 10 km record and the 50 km record. The table below has every value.`}>
      <line x1="8" x2={W - 8} y1={H - 18} y2={H - 18} className="fr-axis" />
      <path d={path((r) => r.coarse_mm)} className="fr-coarse" />
      <path d={path((r) => r.fine_mm)} className="fr-fine" />
      <text x="8" y={H - 4} className="fr-tick">
        {first}
      </text>
      <text x={W - 8} y={H - 4} className="fr-tick" textAnchor="end">
        {last}
      </text>
    </svg>
  );
}

export function FineRainCard({ doc }: { doc: FineRainDoc }) {
  const s = doc.summary;
  if (!s || !doc.years.length) return null;
  const diff = differenceWords(s.difference_pct);
  const span = `${s.first_year} to ${s.last_year}`;
  // "drier" is backed by the years it was lower, "wetter" by the years it was higher.
  const wetter = (s.difference_pct ?? 0) > 0;
  const sides = s.years_fine_lower != null && diff && diff !== "about the same" ? ` (${wetter ? "higher" : "lower"} in ${wetter ? s.years - s.years_fine_lower : s.years_fine_lower} of ${s.years} years)` : "";
  return (
    <section className="db-card fr" aria-label="Rain closer to your field">
      <h2>Rain closer to your field</h2>
      <div className="fr-pair">
        <div>
          <span className="fr-key fr-key-fine" aria-hidden="true" />
          <strong>{rainText(s.fine_mean_mm)}</strong> a year
          <span className="fr-what">10 km square around your field, NASA satellite record</span>
          <OriginBadge origin="nasa_measured" />
        </div>
        {s.coarse_mean_mm != null ? (
          <div>
            <span className="fr-key fr-key-coarse" aria-hidden="true" />
            <strong>{rainText(s.coarse_mean_mm)}</strong> a year
            <span className="fr-what">50 km area, the record this outlook uses</span>
            <OriginBadge origin="nasa_modeled" />
          </div>
        ) : null}
      </div>
      <p className="fr-line">
        {s.coarse_mean_mm != null && diff
          ? `Over ${span}, the 10 km record is ${diff}${diff === "about the same" ? " as" : " than"} the 50 km record${sides}.`
          : `Average of ${span}. ${doc.reason_text ?? ""}`}
      </p>
      <Lines years={doc.years} />
      <details className="gf-more">
        <summary>Rain year by year</summary>
        <div className="acre-input-table-wrap">
          <table className="fr-table">
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">10 km record</th>
                <th scope="col">50 km record</th>
              </tr>
            </thead>
            <tbody>
              {doc.years.map((r) => (
                <tr key={r.year}>
                  <th scope="row" translate="no">
                    {r.year}
                  </th>
                  <td data-label="10 km record">{rainText(r.fine_mm)}</td>
                  <td data-label="50 km record">{r.coarse_mm != null ? rainText(r.coarse_mm) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="gf-muted">Shown for comparison. The 10-year outlook above still uses the 50 km record, so this changes no result. Two records of the same place can differ; your own rain gauge is the best check.</p>
    </section>
  );
}

/** Fetches and shows the card; nothing is shown until there is an answer worth showing. */
export function FineRain({ point }: { point: { latitude: number; longitude: number } }) {
  const [doc, setDoc] = useState<FineRainDoc | null>(null);
  const key = `${Math.floor(point.latitude * 10)}|${Math.floor(point.longitude * 10)}`;
  useEffect(() => {
    let alive = true;
    setDoc(null);
    void fineRain(point).then((d) => {
      if (alive) setDoc(d);
    });
    return () => {
      alive = false;
    };
    // One request per 10 km square.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return doc ? <FineRainCard doc={doc} /> : null;
}
