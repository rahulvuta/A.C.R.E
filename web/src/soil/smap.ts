import colors from "./smapColors.json";

/*
  Soil moisture seen from space (card 31): NASA's SMAP satellite, as published in NASA GIBS's
  ready-made map pictures. No key and no login.

  A map picture is colours, not numbers, but NASA publishes the exact table that turns each
  value into its colour (the GIBS colour map; 255 steps of about 0.003 m³/m³). Reading the
  colour of the picture at the field and looking it up in that table gives the value back, to
  the nearest step. That is what this file does, in the browser: it fetches one small picture
  (a tile about 600 km across at the equator, so the request does not locate the field), reads
  one dot, and looks it up.

  What it is, said on the page: SMAP "Level 4" root-zone soil moisture, which is the
  satellite's readings of the top 5 cm combined with a NASA land model to reach the top metre,
  on squares about 9 km across. It is closer to a measurement than the weather-model wetness
  the 10-year outlook uses, and it is not a reading from the field. It changes no result.
*/
export const SMAP_ROOT = "SMAP_L4_Analyzed_Root_Zone_Soil_Moisture";
export const SMAP_SURFACE = "SMAP_L4_Analyzed_Surface_Soil_Moisture";
export const SMAP_ZOOM = 6;
export const SMAP_FIRST = "2015-03-31";
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const TILE = 256;

export const smapTiles = (layer: string, date: string) => `${GIBS}/${layer}/default/${date}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
const domainUrl = (layer: string) => `${GIBS}/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=${layer}&TILEMATRIXSET=GoogleMapsCompatible_Level6`;

/** The picture tile that holds a point, and the dot inside it (Web Mercator, as the map uses). */
export function tileFor(latitude: number, longitude: number, zoom = SMAP_ZOOM): { x: number; y: number; px: number; py: number } {
  const n = 2 ** zoom;
  const lat = Math.max(-85.0511, Math.min(85.0511, latitude));
  const fx = ((longitude + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(fx)));
  const y = Math.min(n - 1, Math.max(0, Math.floor(fy)));
  return { x, y, px: Math.min(TILE - 1, Math.floor((fx - x) * TILE)), py: Math.min(TILE - 1, Math.floor((fy - y) * TILE)) };
}

const table = new Map<string, { low: number; high: number | null }>((colors.bins as Array<[number, number, number, number, number | null]>).map(([r, g, b, low, high]) => [`${r},${g},${b}`, { low, high }]));
/** The soil moisture a colour stands for (m³ of water per m³ of soil, the middle of its step); null for "no data" or a colour that is not in NASA's table. */
export function valueOfColour(r: number, g: number, b: number, alpha = 255): number | null {
  if (alpha < 128) return null;
  const bin = table.get(`${r},${g},${b}`);
  if (!bin) return null;
  return Math.round(((bin.high == null ? bin.low : (bin.low + bin.high) / 2) + Number.EPSILON) * 1000) / 1000;
}

/** The days NASA has a picture for, as [first, last] spans, from its own answer. */
export function spansFromDomain(xml: string): Array<[string, string]> {
  const domain = /<Domain>([^<]+)<\/Domain>/.exec(xml)?.[1] ?? "";
  return domain.split(",").flatMap((part) => {
    const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/P1D$/.exec(part.trim());
    return m ? [[m[1]!, m[2]!] as [string, string]] : [];
  });
}
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** The day with a picture nearest to `date`, looking up to `within` days either side; null when there is none. Earlier days win a tie. */
export function nearestDay(spans: Array<[string, string]>, date: string, within = 10): string | null {
  const has = (d: string) => spans.some(([a, b]) => d >= a && d <= b);
  for (let k = 0; k <= within; k++) {
    if (has(shift(date, -k))) return shift(date, -k);
    if (k && has(shift(date, k))) return shift(date, k);
  }
  return null;
}
/** The newest `count` days with a picture, newest first. */
export function newestDays(spans: Array<[string, string]>, count = 30): string[] {
  const out: string[] = [];
  for (const [a, b] of [...spans].sort((p, q) => q[1].localeCompare(p[1]))) {
    for (let d = b; d >= a && out.length < count; d = shift(d, -1)) out.push(d);
    if (out.length >= count) break;
  }
  return out;
}

const domains = new Map<string, Promise<Array<[string, string]>>>();
export function smapSpans(layer: string, fetcher: typeof fetch = fetch): Promise<Array<[string, string]>> {
  let hit = domains.get(layer);
  if (!hit) {
    hit = fetcher(domainUrl(layer))
      .then((r) => (r.ok ? r.text() : ""))
      .then(spansFromDomain)
      .catch(() => []);
    domains.set(layer, hit);
    void hit.then((s) => {
      if (!s.length) domains.delete(layer);
    });
  }
  return hit;
}
export function resetSmapForTests() {
  domains.clear();
}

/** One dot of one picture: the value at the point on that day, or null (no picture, a gap, open water, or the browser cannot read pictures). */
/** A browser that can read a dot out of a picture. Without one nothing is fetched (and no test reaches the network). */
export const canReadPictures = () => typeof createImageBitmap === "function" && typeof document !== "undefined";

export async function readSmap(layer: string, date: string, point: { latitude: number; longitude: number }): Promise<number | null> {
  if (!canReadPictures()) return null;
  const t = tileFor(point.latitude, point.longitude);
  try {
    const res = await fetch(smapTiles(layer, date).replace("{z}", String(SMAP_ZOOM)).replace("{y}", String(t.y)).replace("{x}", String(t.x)));
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = document.createElement("canvas");
    canvas.width = TILE;
    canvas.height = TILE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0, TILE, TILE);
    const [r, g, b, a] = ctx.getImageData(t.px, t.py, 1, 1).data;
    return valueOfColour(r!, g!, b!, a);
  } catch {
    return null;
  }
}

export interface SmapYear {
  year: number;
  /** The day the picture is from (the planting day, or the nearest day NASA has). */
  date: string;
  value: number;
}
/** Root-zone soil moisture on a month-day ("03-15") in every year NASA has it, oldest first. */
export async function smapOnDay(monthDay: string, point: { latitude: number; longitude: number }, today = new Date()): Promise<SmapYear[]> {
  if (!canReadPictures() || !/^\d{2}-\d{2}$/.test(monthDay)) return [];
  const spans = await smapSpans(SMAP_ROOT);
  if (!spans.length) return [];
  const last = today.toISOString().slice(0, 10);
  const wanted: Array<{ year: number; date: string }> = [];
  for (let year = 2015; year <= today.getUTCFullYear(); year++) {
    const target = `${year}-${monthDay === "02-29" ? "02-28" : monthDay}`;
    if (target < SMAP_FIRST || target > last) continue;
    const date = nearestDay(spans, target);
    if (date) wanted.push({ year, date });
  }
  const values = await Promise.all(wanted.map((w) => readSmap(SMAP_ROOT, w.date, point)));
  return wanted.flatMap((w, i) => (values[i] == null ? [] : [{ ...w, value: values[i]! }]));
}

/** "28%": the share of the soil's volume that is water, the way a moisture meter reads. */
export const asPercent = (value: number) => `${Math.round(value * 100)}%`;
export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
