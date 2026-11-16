import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { APP_NAME } from "../../config";
import type { Share } from "./share";

/*
  "Share" on step 6 (card 22). One printed page and a short text version of the same content.
  The page is drawn outside the app's layout and only when printing, so the paper carries the
  plan and nothing else. The text is copied from what is on screen, so it is in the language
  the grower is reading.
*/
function Blocks({ share }: { share: Share }) {
  return (
    <>
      <h2 className="sp-title">
        10-year plan for <span translate="no">{share.fieldName}</span>
        {share.size ? <span translate="no"> ({share.size})</span> : null}
      </h2>
      <p className="sp-plan">{share.planLine}</p>
      {share.jobs.length ? (
        <section>
          <h3>This season</h3>
          <ol>
            {share.jobs.map((j) => (
              <li key={j}>{j}</li>
            ))}
          </ol>
        </section>
      ) : null}
      {share.sentences.length ? (
        <section>
          <h3>What the past weather says</h3>
          <ul>
            {share.sentences.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>Where the numbers come from</h3>
        <ul>
          {share.sources.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>
      {share.cautions.length ? (
        <section>
          <h3>Not in these results</h3>
          <ul>
            {share.cautions.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer>
        {share.foot.map((t) => (
          <p key={t}>{t}</p>
        ))}
      </footer>
    </>
  );
}

/** The on-screen blocks as message text: headings on their own line, list items numbered or dashed. */
export function textOf(root: HTMLElement): string {
  const lines: string[] = [];
  const say = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  for (const el of Array.from(root.children)) {
    if (el.tagName === "SECTION") {
      lines.push(say(el.querySelector("h3")?.textContent));
      const ordered = Boolean(el.querySelector("ol"));
      el.querySelectorAll("li").forEach((li, i) => lines.push(`${ordered ? `${i + 1}.` : "-"} ${say(li.textContent)}`));
      lines.push("");
    } else if (el.tagName === "FOOTER") {
      el.querySelectorAll("p").forEach((p) => lines.push(say(p.textContent)));
    } else {
      lines.push(say(el.textContent));
      if (el.classList.contains("sp-plan")) lines.push("");
    }
  }
  return lines.join("\n").trim();
}

export function SharePlan({ share, onExport }: { share: Share; onExport: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const text = useRef<HTMLDivElement>(null);
  const canSend = typeof navigator !== "undefined" && typeof navigator.share === "function";

  // The paper shows the page only while this print is running; any other print of the step is untouched.
  useEffect(() => {
    const done = () => document.body.classList.remove("share-print");
    window.addEventListener("afterprint", done);
    return () => {
      window.removeEventListener("afterprint", done);
      done();
    };
  }, []);
  const print = () => {
    document.body.classList.add("share-print");
    window.print();
  };
  const message = () => (text.current ? textOf(text.current) : "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message());
      setCopied("yes");
    } catch {
      // No clipboard permission: select the text so the grower can copy it by hand.
      const range = document.createRange();
      if (text.current) {
        range.selectNodeContents(text.current);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
      setCopied("failed");
    }
  };
  const send = async () => {
    try {
      await navigator.share({ title: share.title, text: message() });
    } catch {
      /* closed without sending */
    }
  };

  return (
    <>
      <button type="button" className="btn btn-primary gf-no-print" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Share
      </button>
      {open ? (
        <section className="sp-panel gf-no-print" aria-label="Share this plan">
          <div className="sp-actions">
            <button type="button" className="btn btn-secondary" onClick={print}>
              Print one page
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
              {copied === "yes" ? "Copied" : "Copy as a message"}
            </button>
            {canSend ? (
              <button type="button" className="btn btn-secondary" onClick={() => void send()}>
                Send…
              </button>
            ) : null}
            <button type="button" className="btn btn-quiet" onClick={onExport}>
              Save as a file
            </button>
          </div>
          <p className="gf-muted" role="status">
            {copied === "yes" ? "Copied. Paste it into a message." : copied === "failed" ? "The text is selected: copy it, then paste it into a message." : "This is what is shared. It has the field's name and size, and nothing that shows where the field is."}
          </p>
          <div className="sp-text" ref={text}>
            <Blocks share={share} />
          </div>
        </section>
      ) : null}
      {createPortal(
        <div className="share-page" aria-hidden="true">
          <p className="sp-brand" translate="no">
            {APP_NAME}
          </p>
          <Blocks share={share} />
        </div>,
        document.body,
      )}
    </>
  );
}
