/*
  How green the land was, by month (card 28): NASA's ready-made MODIS Terra vegetation index
  (NDVI) tiles from GIBS, the same pictures NASA Worldview shows. No key, no login.

  What a grower should know, and the page says: one square of this layer is about 1 km across,
  so it shows the land around a field, not the field alone; and it is a picture of plant cover
  from space, not a measure of the crop or its yield.
*/
export const GREEN_LAYER = "MODIS_Terra_L3_NDVI_Monthly";
export const GREEN_SOURCE = "nasa-greenness";
export const GREEN_LAYER_ID = "nasa-greenness-layer";
/** GIBS serves this layer down to zoom 7 (about 1 km); the map stretches it when zoomed in closer. */
export const GREEN_MAXZOOM = 7;
export const GREEN_ATTRIBUTION = 'Greenness: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noreferrer">NASA GIBS</a>, MODIS Terra vegetation index';
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const DOMAINS = `${GIBS}/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=${GREEN_LAYER}&TILEMATRIXSET=GoogleMapsCompatible_Level7`;
/** NASA's own colours for this layer, from little plant cover to dense green (GIBS colour map MODIS_L3_NDVI). */
export const GREEN_SCALE = ["#f1ecec", "#ddc9bc", "#b19883", "#bfde77", "#8fb716", "#56a101", "#398700", "#1d7500", "#056400", "#004800"];
const MAX_MONTHS = 60;

/** The tile address for one month ("2026-10"). */
export const greenTiles = (month: string) => `${GIBS}/${GREEN_LAYER}/default/${month}-01/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`;

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
/** Every month from `first` to `last` ("YYYY-MM"), in order. */
function span(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split("-").map(Number) as [number, number];
  const [ly, lm] = last.split("-").map(Number) as [number, number];
  while (y < ly || (y === ly && m <= lm)) {
    out.push(ym(y, m));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * The months GIBS has, newest first, from its own answer
 * ("2000-03-01/2025-03-01/P1M,2025-05-01/2026-10-01/P1M"). A month missing from the answer
 * (a satellite outage) is missing here, so it is never offered.
 */
export function monthsFromDomain(xml: string): string[] {
  const domain = /<Domain>([^<]+)<\/Domain>/.exec(xml)?.[1] ?? "";
  const months = domain
    .split(",")
    .flatMap((part) => {
      const m = /^(\d{4}-\d{2})-\d{2}\/(\d{4}-\d{2})-\d{2}\/P1M$/.exec(part.trim());
      return m ? span(m[1]!, m[2]!) : [];
    })
    .sort()
    .reverse();
  return [...new Set(months)].slice(0, MAX_MONTHS);
}

/** Without GIBS's answer: the months up to two months ago (the newest month takes a few weeks to appear). */
export function likelyMonths(today = new Date()): string[] {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (MAX_MONTHS - 1), 1));
  return span(ym(start.getUTCFullYear(), start.getUTCMonth() + 1), ym(end.getUTCFullYear(), end.getUTCMonth() + 1)).reverse();
}

let asked: Promise<string[]> | null = null;
/** The months that can be shown, asked from GIBS once per visit. */
export function greenMonths(fetcher: typeof fetch = fetch): Promise<string[]> {
  asked ??= fetcher(DOMAINS)
    .then((r) => (r.ok ? r.text() : ""))
    .then((xml) => {
      const months = monthsFromDomain(xml);
      return months.length ? months : likelyMonths();
    })
    .catch(() => likelyMonths());
  return asked;
}
export function resetGreenMonthsForTests() {
  asked = null;
}

/** "October 2026", in the browser's own language. */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}
