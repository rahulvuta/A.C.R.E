import { useState, type ReactNode } from "react";
import { APP_NAME } from "../../config";
import { putFarm, selectField } from "../../farm/hooks";
import { loadDemoFields } from "../../state/simField";
import { useGlobalApi, type GlobalApi } from "../../state/useGlobal";
import { Banner } from "../../ui/components";
import { STEPS, type StepId } from "../guided/steps";

/*
  The first screen a grower sees when this browser has no fields yet. It says what the app
  does in one line, lays out the six steps of the guided sequence in order, and starts it.
  "See an example farm" loads the Union County demo farm (flagged as a demo, kept apart from
  the grower's own fields) and opens the sequence with every step filled in.
*/

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const icon = (body: ReactNode) => (
  <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" {...stroke}>
    {body}
  </svg>
);
/** One line drawing per step, in the order of the sequence. */
const ICONS: Record<StepId, ReactNode> = {
  farm: icon(<><path d="M4 9.500l6-4 10 3-2 9.500-9 2-5-4z" /><path d="M10 5.500l-1 14.500M4 9.500l14 8.500" strokeOpacity="0.45" /></>),
  now: icon(<><path d="M12 21v-9" /><path d="M12 12c0-3.500 2.500-6 6.500-6 0 3.500-2.500 6-6.500 6z" /><path d="M12 15c0-2.500-2-4.500-5.500-4.500 0 2.500 2 4.500 5.500 4.500z" /></>),
  simulate: icon(<><path d="M7.500 15a4 4 0 0 1 .300-8 5 5 0 0 1 9.500 1.400A3.300 3.300 0 0 1 17 15z" /><path d="M9 18v2M12 18v3M15 18v2" /></>),
  try: icon(<><path d="M4 12h5l4-5h7M9 12l4 5h7" /><path d="M17.500 4.500L20 7l-2.500 2.500M17.500 14.500L20 17l-2.500 2.500" /></>),
  compare: icon(<><path d="M6 20V11M12 20V5M18 20v-6" strokeWidth="3" /><path d="M3 20h18" /></>),
  plan: icon(<><path d="M5 6.500h14V20H5zM5 10.500h14M9 4v4M15 4v4" /><path d="M9 15.500l2 2 4-4" /></>),
};

type Demo = { state: "idle" } | { state: "loading" } | { state: "error"; message: string };

export function Welcome({ api: given, go = (url) => window.location.assign(url) }: { api?: GlobalApi; go?: (url: string) => void }) {
  const fallback = useGlobalApi();
  const api = given ?? fallback;
  const [demo, setDemo] = useState<Demo>({ state: "idle" });

  const example = async () => {
    setDemo({ state: "loading" });
    const r = await api.client.demoFarm("union");
    if (!r.ok) return setDemo({ state: "error", message: r.message });
    putFarm({ ...r.data.farm, demo: r.data.label });
    loadDemoFields(r.data);
    selectField(r.data.farm.fields[0]?.field_id ?? null);
    go("?view=app#u=now&p=crops");
  };

  return (
    <div className="wl">
      <header className="wl-top">
        <span className="wl-brand">
          <span className="fb-mark" aria-hidden="true" />
          {APP_NAME}
        </span>
        <nav className="wl-links" aria-label="About">
          <a href="?view=methods">How it works</a>
          <a href="?view=privacy">Privacy</a>
        </nav>
      </header>
      <main className="wl-main">
        <section className="wl-hero" aria-labelledby="wl-title">
          <div className="wl-copy">
            <h1 id="wl-title">See how your field holds up over the next 10 years.</h1>
            <p className="wl-lead">Your crops and dates, replayed through 45 years of real NASA weather for your spot.</p>
            <div className="wl-actions">
              <a className="btn btn-primary btn-large" href="?view=app">
                Start with my field
              </a>
              {api.source === "none" ? (
                <a className="btn btn-secondary btn-large" href="?view=demo">
                  See an example farm
                </a>
              ) : (
                <button type="button" className="btn btn-secondary btn-large" onClick={() => void example()} disabled={demo.state === "loading"}>
                  {demo.state === "loading" ? "Loading the example…" : "See an example farm"}
                </button>
              )}
            </div>
            {demo.state === "error" ? <Banner kind="error">{demo.message}</Banner> : null}
            <ul className="wl-facts" aria-label="Good to know">
              <li>About 5 minutes</li>
              <li>No account</li>
              <li>Saved in this browser only</li>
            </ul>
          </div>
          <HeroPicture />
        </section>
        <section className="wl-path" aria-label="The six steps">
          <ol>
            {STEPS.map((s) => (
              <li key={s.id}>
                <span className="wl-step-top">
                  <span className="wl-num" aria-hidden="true">
                    {s.n}
                  </span>
                  <span className="wl-icon">{ICONS[s.id]}</span>
                </span>
                <strong>{s.nav}</strong>
                <span className="wl-q">{s.question}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}

/** A field under rain, and the ten seasons that follow it: the app in one picture. Decorative. */
function HeroPicture() {
  const rows = Array.from({ length: 9 }, (_, i) => i);
  const years = Array.from({ length: 10 }, (_, i) => 2027 + i);
  return (
    <svg className="wl-pic" viewBox="0 0 520 380" role="img" aria-label="A field under rain, followed by ten seasons of crops">
      <g className="wl-pic-rain">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => (
          <path key={i} d={`M${96 + i * 30} ${34 + (i % 3) * 14}l-7 22`} style={{ animationDelay: `${(i % 4) * 0.35}s` }} />
        ))}
      </g>
      {/* The field: a tilted plot with crop rows, soil underneath. */}
      <path className="wl-pic-soil" d="M60 196L260 116l200 80v22L260 298 60 218z" />
      <path className="wl-pic-top" d="M60 196L260 116l200 80-200 80z" />
      <g className="wl-pic-rows">
        {rows.map((i) => {
          const t = (i + 1) / 10;
          return <path key={i} d={`M${60 + 200 * t} ${196 + 80 * t}L${260 + 200 * t} ${116 + 80 * t}`} />;
        })}
      </g>
      {/* Ten seasons: corn and soybean in turn, with a winter cover under some of them. */}
      <g className="wl-pic-years">
        {years.map((y, i) => (
          <g key={y} transform={`translate(${22 + i * 48} 318)`}>
            <rect className={i % 2 ? "wl-pic-soy" : "wl-pic-corn"} width="42" height="26" rx="4" />
            <rect className={i > 3 ? "wl-pic-cover" : "wl-pic-bare"} y="30" width="42" height="6" rx="3" />
            <text x="21" y="54" textAnchor="middle">
              {y}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
