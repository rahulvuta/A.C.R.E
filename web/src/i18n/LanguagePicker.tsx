import { useEffect, useRef, useState } from "react";
import { LANGUAGES, languageFor } from "./languages";
import { chooseLanguage, useTranslator } from "./translator";

/*
  The grower picks any language by name (card 18): a list of common ones in their own script,
  and a box to type any other. The choice is remembered. Every translated screen carries the
  "Machine translated" mark with a way back to English.
*/
const OTHER = "__other__";

export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { language } = useTranslator();
  const listed = language && LANGUAGES.some((l) => l.name === language.name);
  const [other, setOther] = useState(false);
  const [typed, setTyped] = useState("");
  const pick = (value: string) => {
    if (value === OTHER) return setOther(true);
    chooseLanguage(value ? languageFor(value) : null);
  };
  const typedLanguage = languageFor(typed);
  return (
    <div className={`lang${compact ? " lang-compact" : ""}`} translate="no">
      <label className="lang-label">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="8.500" />
          <path d="M3.500 12h17M12 3.500c2.500 2.300 3.800 5.100 3.800 8.500s-1.300 6.200-3.800 8.500c-2.500-2.300-3.800-5.100-3.800-8.500s1.300-6.200 3.800-8.500z" />
        </svg>
        <span className="lang-word">Language</span>
        <select aria-label="Language" value={other ? OTHER : language ? (listed ? language.name : OTHER) : ""} onChange={(e) => pick(e.target.value)}>
          <option value="">English</option>
          {LANGUAGES.map((l) => (
            <option key={l.name} value={l.name}>
              {l.native} · {l.name}
            </option>
          ))}
          <option value={OTHER}>{language && !listed ? language.name : "Another language…"}</option>
        </select>
      </label>
      {other ? (
        <form
          className="lang-other"
          onSubmit={(e) => {
            e.preventDefault();
            if (typedLanguage) chooseLanguage(typedLanguage);
          }}
        >
          <input aria-label="Type the name of your language" placeholder="Type your language" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          <button type="submit" className="btn btn-secondary" disabled={!typedLanguage}>
            Use it
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** A slim strip at the top of every translated screen: what it is, and the way back to English. */
export function TranslatedMark() {
  const { language, status, reason } = useTranslator();
  const ref = useRef<HTMLDivElement>(null);
  // The strip stays at the top while the page scrolls; the sidebar and the page's own top bar
  // sit just under it, so they need its height.
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    const set = () => root.style.setProperty("--lang-top", `${el.offsetHeight}px`);
    set();
    const watch = typeof ResizeObserver !== "undefined" ? new ResizeObserver(set) : null;
    watch?.observe(el);
    return () => {
      watch?.disconnect();
      root.style.removeProperty("--lang-top");
    };
  }, [language]);
  if (!language) return null;
  return (
    <div className="lang-mark" role="note" data-status={status} ref={ref}>
      <span>
        <strong>Machine translated</strong>
        <span translate="no"> · {language.native}</span>
        {status === "working" ? <span className="lang-busy"> · translating…</span> : null}
        {status === "unavailable" ? <span className="lang-warn"> · {reason ?? "Translation is not available right now. Showing English for now."}</span> : null}
      </span>
      <button type="button" className="lang-back" translate="no" onClick={() => chooseLanguage(null)}>
        English
      </button>
    </div>
  );
}
