import { useSyncExternalStore } from "react";
import { API_BASE } from "../config";
import { languageFor, type Language } from "./languages";
import { mask, translatable, unmask, type Masked } from "./mask";

/*
  Any language, without translation files (card 18). English stays the one source text. This
  small translator reads the text that is on the screen, asks the service for any sentence it
  has not seen in the grower's language, and swaps the text in. New screens, and text that
  comes from the service, are covered with no extra work.

  What it will not touch:
  - anything the grower typed (form values are never read; names of fields, farms and places
    are marked `translate="no"` in the page and skipped), so no personal text is sent;
  - numbers: they are taken out before a sentence is sent and put back after (`mask.ts`);
  - text inside `translate="no"`, code, and the map's own credits.

  Every sentence is saved in the browser and on the service, so it is translated once.
  The result is machine translation and the page says so on every screen.
*/
const LANG_KEY = "acre.lang.v1";
const SAVED_PREFIX = "acre.tr.v1.";
const MAX_SAVED = 5000;
const BATCH = 40;
const BATCH_CHARS = 6000;
// `data-label` is the column name shown above each value when a table is stacked as cards on a phone.
const ATTRS = ["placeholder", "aria-label", "title", "alt", "data-label"] as const;
const SKIP = 'script, style, noscript, code, pre, textarea, svg text, [translate="no"], .maplibregl-ctrl-attrib, .maplibregl-ctrl-scale';

export type TranslateStatus = "off" | "working" | "ready" | "unavailable";
export interface TranslatorState {
  language: Language | null;
  status: TranslateStatus;
  /** Why translation is not available, in plain words (in English: it could not be translated). */
  reason: string | null;
}

type Fetcher = (language: string, texts: string[]) => Promise<{ translations: Array<string | null>; status: string; reason: string | null }>;

// ------------------------------------------------------------------ the chosen language
export function readLanguage(): Language | null {
  try {
    const raw = window.localStorage.getItem(LANG_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Language>;
    return typeof v.name === "string" ? (languageFor(v.name) ?? null) : null;
  } catch {
    return null;
  }
}
/** Remembers the grower's language and reloads, so every screen starts again from its English source. */
export function chooseLanguage(language: Language | null, reload: () => void = () => window.location.reload()) {
  try {
    if (language) window.localStorage.setItem(LANG_KEY, JSON.stringify({ name: language.name }));
    else window.localStorage.removeItem(LANG_KEY);
  } catch {
    /* private mode: the choice lasts until the page is closed */
  }
  reload();
}

// ------------------------------------------------------------------ state for the page
let state: TranslatorState = { language: null, status: "off", reason: null };
const listeners = new Set<() => void>();
const setState = (patch: Partial<TranslatorState>) => {
  const next = { ...state, ...patch };
  if (next.language === state.language && next.status === state.status && next.reason === state.reason) return;
  state = next;
  listeners.forEach((l) => l());
};
export function useTranslator(): TranslatorState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

// ------------------------------------------------------------------ saved sentences
let memory = new Map<string, string>();
let saveTimer: number | undefined;
const savedKey = (language: Language) => SAVED_PREFIX + language.name.toLowerCase();
function loadSaved(language: Language) {
  memory = new Map();
  try {
    const raw = window.localStorage.getItem(savedKey(language));
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) if (typeof v === "string") memory.set(k, v);
  } catch {
    /* an unreadable store starts empty */
  }
}
function saveSoon(language: Language) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const entries = [...memory.entries()].slice(-MAX_SAVED);
      window.localStorage.setItem(savedKey(language), JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* a full store: sentences are still saved on the service */
    }
  }, 800);
}

// ------------------------------------------------------------------ the service call
const liveFetch: Fetcher = async (language, texts) => {
  if (!API_BASE) return { translations: texts.map(() => null), status: "unavailable", reason: "Translation needs the A.C.R.E service, which this copy of the app is not connected to." };
  const res = await fetch(`${API_BASE.replace(/\/$/, "")}/v1/translate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language, texts }) });
  if (!res.ok) return { translations: texts.map(() => null), status: "unavailable", reason: "The translation service could not be reached. Showing English for now." };
  const body = (await res.json()) as { translations?: unknown; status?: string; reason_text?: string | null };
  const list = Array.isArray(body.translations) ? body.translations : [];
  return { translations: texts.map((_t, i) => (typeof list[i] === "string" ? (list[i] as string) : null)), status: body.status ?? "complete", reason: body.reason_text ?? null };
};

// ------------------------------------------------------------------ the grower's own names
/*
  A second guard beside `translate="no"`: any sentence that holds a name the grower gave (a
  field, a farm, a zone, a plan of their own, a note) is not translated and so never sent. A
  name can end up inside a sentence or a label by mistake ("Current plan for Lower field");
  this catches it wherever it is. The app's own starting names ("My farm", "Field 1") are not
  private and are left alone.
*/
const OWN_KEYS = ["acre.farms.v1", "acre.simfield.v1"];
const APP_NAMES = /^(my farm|field \{0\}|zone \{0\}|season \{0\}|what i do now)$/;
let ownRaw: string | null = null;
let ownNames: string[] = [];
function growerNames(): string[] {
  let raw = "";
  try {
    raw = OWN_KEYS.map((k) => window.localStorage.getItem(k) ?? "").join("\u0000");
  } catch {
    return ownNames;
  }
  if (raw === ownRaw) return ownNames;
  ownRaw = raw;
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const k = mask(v).key.trim().toLowerCase();
    if (k.length >= 3 && !APP_NAMES.test(k)) out.add(k);
  };
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  try {
    const [farms, sims] = raw.split("\u0000").map((t) => (t ? (JSON.parse(t) as unknown) : null));
    for (const f of list(obj(farms).farms)) {
      if (!obj(f).demo) add(obj(f).name);
      for (const fl of list(obj(f).fields)) {
        if (!obj(f).demo) add(obj(fl).name);
        add(obj(fl).notes);
      }
    }
    for (const sf of Object.values(obj(obj(sims).fields))) {
      for (const z of list(obj(sf).zones)) add(obj(z).name);
      for (const sc of list(obj(sf).scenarios)) if (obj(sc).from === "custom") add(obj(sc).label);
      for (const r of list(obj(sf).readings)) add(obj(r).note);
    }
  } catch {
    /* unreadable storage: nothing more to protect than what is marked in the page */
  }
  ownNames = [...out];
  return ownNames;
}
/** True when a sentence (already masked) holds one of the grower's own names. */
export function holdsGrowerName(key: string): boolean {
  const k = key.toLowerCase();
  return growerNames().some((n) => k.includes(n));
}

/** True when a translation holds exactly the number places of its source: none missing, added or repeated. */
const places = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join("|");
export const samePlaces = (source: string, translated: string) => places(source) === places(translated);

// ------------------------------------------------------------------ the translator
interface Shown {
  src: string;
  out: string;
}
const textShown = new WeakMap<Text, Shown>();
const attrShown = new WeakMap<Element, Partial<Record<(typeof ATTRS)[number], Shown>>>();

export interface Translator {
  stop(): void;
  /** Resolves when nothing is waiting to be translated (for tests). */
  settled(): Promise<void>;
}

export function startTranslator(language: Language, root: HTMLElement = document.body, fetcher: Fetcher = liveFetch): Translator {
  loadSaved(language);
  setState({ language, status: "working", reason: null });
  document.documentElement.lang = language.code || "";
  document.documentElement.dir = language.rtl ? "rtl" : "ltr";

  const waiting = new Set<string>();
  const asked = new Set<string>();
  /** Sentences the service could not give this visit; asked again only after a pause. */
  const refused = new Map<string, number>();
  let scanTimer: number | undefined;
  let sendTimer: number | undefined;
  let inFlight = 0;
  let stopped = false;
  let pausedUntil = 0;
  const idle: Array<() => void> = [];

  const settle = () => {
    if (!waiting.size && !inFlight) {
      if (state.status === "working") setState({ status: "ready" });
      idle.splice(0).forEach((f) => f());
    }
  };

  const want = (m: Masked): string | null => {
    if (!translatable(m.key) || holdsGrowerName(m.key)) return null;
    const hit = memory.get(m.key);
    if (hit !== undefined) return unmask(hit, m);
    const again = refused.get(m.key);
    if (!asked.has(m.key) && (!again || again < Date.now())) waiting.add(m.key);
    return null;
  };

  const scan = () => {
    scanTimer = undefined;
    if (stopped) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node as Text;
        const parent = text.parentElement;
        if (!parent || parent.closest(SKIP)) continue;
        const raw = text.nodeValue ?? "";
        const shown = textShown.get(text);
        if (shown && raw === shown.out) continue;
        const out = want(mask(raw));
        if (out != null && out !== raw) {
          textShown.set(text, { src: raw, out });
          text.nodeValue = out;
        }
      } else {
        const el = node as Element;
        if (el.closest(SKIP)) continue;
        for (const attr of ATTRS) {
          const raw = el.getAttribute(attr);
          if (!raw) continue;
          const shown = attrShown.get(el)?.[attr];
          if (shown && raw === shown.out) continue;
          const out = want(mask(raw));
          if (out != null && out !== raw) {
            attrShown.set(el, { ...attrShown.get(el), [attr]: { src: raw, out } });
            el.setAttribute(attr, out);
          }
        }
      }
    }
    if (waiting.size && sendTimer === undefined && Date.now() >= pausedUntil) sendTimer = window.setTimeout(send, 150);
    settle();
  };
  const scanSoon = () => {
    if (scanTimer === undefined && !stopped) scanTimer = window.setTimeout(scan, 60);
  };

  const send = async () => {
    sendTimer = undefined;
    if (stopped || !waiting.size) return settle();
    const batch: string[] = [];
    let chars = 0;
    for (const key of waiting) {
      if (batch.length >= BATCH || chars + key.length > BATCH_CHARS) break;
      batch.push(key);
      chars += key.length;
    }
    batch.forEach((k) => {
      waiting.delete(k);
      asked.add(k);
    });
    inFlight++;
    if (state.status !== "unavailable") setState({ status: "working" });
    try {
      const r = await fetcher(language.name, batch);
      let got = 0;
      batch.forEach((key, i) => {
        const t = r.translations[i];
        // A translation is kept only if every number's place survived it.
        if (t && samePlaces(key, t)) {
          memory.set(key, t);
          got++;
        } else {
          refused.set(key, Date.now() + 120_000);
          asked.delete(key);
        }
      });
      if (got) saveSoon(language);
      if (r.status === "unavailable") {
        // Nothing new can be translated right now: say so, and stop asking for a while.
        pausedUntil = Date.now() + 60_000;
        setState({ status: "unavailable", reason: r.reason ?? "Translation is not available right now. Showing English for now." });
      } else if (state.status === "unavailable") setState({ status: "working", reason: null });
    } catch {
      batch.forEach((k) => {
        asked.delete(k);
        refused.set(k, Date.now() + 120_000);
      });
      pausedUntil = Date.now() + 60_000;
      setState({ status: "unavailable", reason: "The translation service could not be reached. Showing English for now." });
    } finally {
      inFlight--;
    }
    if (stopped) return;
    scan();
    if (waiting.size && sendTimer === undefined && Date.now() >= pausedUntil) sendTimer = window.setTimeout(send, 30);
    settle();
  };

  const observer = new MutationObserver(scanSoon);
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  scan();

  return {
    stop() {
      stopped = true;
      observer.disconnect();
      window.clearTimeout(scanTimer);
      window.clearTimeout(sendTimer);
    },
    settled: () =>
      new Promise<void>((resolve) => {
        if (!waiting.size && !inFlight && scanTimer === undefined) resolve();
        else idle.push(resolve);
      }),
  };
}

/** Starts translating if the grower has chosen a language; called once when the app opens. */
export function startChosenLanguage(): Translator | null {
  const language = readLanguage();
  if (!language) return null;
  return startTranslator(language);
}

export function resetTranslatorForTests() {
  memory = new Map();
  ownRaw = null;
  ownNames = [];
  state = { language: null, status: "off", reason: null };
  document.documentElement.dir = "ltr";
}
