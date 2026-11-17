import type { ReactNode } from "react";
import { APP_NAME, CHALLENGE_LABEL } from "../config";
import { mm } from "../data/format";
import { WinterPicture } from "../screens/planner/WinterPicture";
import { CalendarScene, CompareScene, RyeScene, SpringsScene } from "./demo/scenes";
import { app, Arrow, Chevron, Lazy, Reveal, SiteShell, to, useNumbers, whole, type Numbers } from "./Site";
import { EvidencePrinciples, ExampleLink, PlanningPreview, PlanningSteps, RecordFacts, RecordPlaceholder } from "./PlanningStory";
import { useSiteData } from "./useSiteData";
import { BareRainCard, SpringDotsCard, SummarySheet } from "./visuals";

const Check = ({ children }: { children: ReactNode }) => <li>{children}</li>;

export function ProductPage() {
  const data = useSiteData();
  const n = useNumbers(data);
  return (
    <SiteShell current="product" title={`Crop rotation planning · ${APP_NAME}`} springs={n?.springs ?? null}>
      <section className="st-wrap st-global-hero st-product-hero">
        <div className="st-global-hero-copy st-rise">
          <p className="st-eyebrow">The product</p>
          <h1>Start with your field.<span>Plan beyond a single season.</span></h1>
          <p className="st-hero-description">Your location, soil context, crop history and goals shape the rotation options. NASA weather history and local guidance help explain which plans to consider, and why.</p>
          <div className="st-hero-cta"><a className="btn btn-primary" href={app()}>Find your farm</a><a className="btn btn-secondary" href="#product-example">Explore the NC example</a></div>
        </div>
        <PlanningPreview />
      </section>
      <section className="st-wrap st-section" id="planning-workflow">
        <div className="st-section-head"><p className="st-eyebrow">How it works</p><h2 className="st-h2">Your priorities shape the plan.<span>The evidence explains the choices.</span></h2></div>
        <PlanningSteps />
      </section>
      <section className="st-band" id="shortlist">
        <div className="st-wrap st-section">
          <div className="st-section-head"><p className="st-eyebrow">Read the shortlist</p><h2 className="st-h2">Understand each option.<span>Choose the trade-offs you can work with.</span></h2><p className="st-sub">Generated rotations are compared over named indicators. Your priorities order the shortlist; each plan keeps its own reasons and uncertainties.</p></div>
          <div className="st-explanation-grid">
            <article><h3>Why consider this rotation?</h3><p>See how a plan relates to your goals, with indicators such as living-cover days, crop diversity and rain on bare soil.</p></article>
            <article><h3>What does it ask of you?</h3><p>Look at timing, field operations, local rule checks and the historical seasons that exposed a vulnerability.</p></article>
            <article id="future-plan"><h3>What happens next?</h3><p>Carry a chosen rotation into a multi-season plan with planting and harvest windows, cover schedules and decision dates.</p></article>
          </div>
          <p className="st-example-note">Soil and water indicators follow sourced principles. They are not measured improvements or outcome predictions.</p>
        </div>
      </section>
      <section className="st-wrap st-section" id="product-example">
        <div className="st-section-head st-example-head"><div><p className="st-eyebrow">Inside the worked example · Union County, NC</p><h2 className="st-h2">Explore the dates.<span>Inspect the history behind them.</span></h2></div><p className="st-sub">The existing NC demo compares corn and soybean rotations. Each winter has its own results and denominators. The recordings below use that saved record.</p></div>
        <div className="st-recording">{data ? <CompareScene data={data} /> : <RecordPlaceholder failed={data === null} ratio="1180 / 720" />}</div>
        {n ? <RecordFacts n={n} /> : null}
        <div className="st-demo-grid">
          {[
            { title: "Inspect a past spring", text: "Change the historical year while keeping the plan's dates fixed.", href: app("pg=springs"), scene: data ? <SpringsScene data={data} chrome={false} play="hover" /> : null, ratio: "1180 / 700" },
            { title: "Try a different rye date", text: "See the historical checks alongside the NC timing guidance.", href: app("s=cover&pg=rye"), scene: data ? <RyeScene data={data} chrome={false} play="hover" /> : null, ratio: "1180 / 700" },
            { title: "Read the field calendar", text: "See each planned job under its month, one winter at a time.", href: app("pg=calendar"), scene: data ? <CalendarScene data={data} chrome={false} play="hover" /> : null, ratio: "1180 / 690" },
          ].map((card) => <article className="st-demo-card" key={card.title}><div className="st-demo-shot"><Lazy ratio={card.ratio}>{card.scene}</Lazy></div><a href={card.href}><h3>{card.title}</h3><p>{card.text}</p><span className="st-link">Open the NC example <Chevron /></span></a></article>)}
        </div>
      </section>
      <section className="st-wrap st-section"><div className="st-section-head"><h2 className="st-h2">Keep the reasoning with the plan.<span>Make room for what is unknown.</span></h2></div><EvidencePrinciples /><div className="st-section-link"><ExampleLink /></div></section>
    </SiteShell>
  );
}

export function GrowersPage() {
  const data = useSiteData();
  const n = useNumbers(data);
  const bands: Array<{ tag: string; title: string; text: string; points: string[]; visual: ReactNode; caption: string; link: [string, string] }> = [
    {
      tag: "Growers",
      title: "A starting point for your next rotation.",
      text: "Locate your farm, draw the fields and tell the planner what matters. Explore options that reflect your crops, history and practical limits.",
      points: ["Set goals for each field", "Compare the reasons and trade-offs", "Carry the choice into a multi-season plan"],
      visual: n ? <BareRainCard n={n} /> : null,
      caption: "Worked example · Union County, NC · winter after corn",
      link: ["Find your farm", app()],
    },
    {
      tag: "Advisers & Extension agents",
      title: "Keep the evidence in the conversation.",
      text: "Discuss the priorities behind a rotation alongside its dates, sources and checks. Local guidance is tied to the place it applies.",
      points: ["Inspect the source behind a check", "Keep uncertainties visible", "Use the NC example's printable summary to explore the discussion format"],
      visual: <SummarySheet />,
      caption: "Illustration of the NC example's Extension summary",
      link: ["Open the sample summary", app("v=summary")],
    },
    {
      tag: "Students & researchers",
      title: "Follow the reasoning back to the record.",
      text: "Explore how planned dates meet historical weather. Inspect the sources and limits that sit behind the comparison.",
      points: ["Replay the saved Union County record", "Keep historical evidence separate from future expectations", "Read the definitions and data limits"],
      visual: n ? <SpringDotsCard n={n} /> : null,
      caption: "Worked example · Union County, NC · cereal rye before soybeans",
      link: ["Explore the evidence", to("evidence")],
    },
  ];
  return (
    <SiteShell current="growers" title={`Who it's for · ${APP_NAME}`} springs={n?.springs ?? null}>
      <section className="st-wrap st-page-intro">
        <p className="st-eyebrow">Who it's for</p>
        <h1>For the people making<span>the next field decision.</span></h1>
        <p>Growers planning a rotation, advisers talking through the options, and anyone who wants to understand the evidence behind a plan. Start anywhere on the map; local evidence determines what can be generated.</p>
        <div className="st-hero-cta"><a className="btn btn-primary" href={app()}>Find your farm</a><a className="btn btn-secondary" href={to("product")}>Explore the product</a></div>
      </section>
      {bands.map((band, index) => (
        <section className={`st-aud${index % 2 ? " is-tint" : ""}`} key={band.tag}>
          <div className="st-wrap st-aud-in">
            <Reveal><p className="st-eyebrow">{band.tag}</p><h2 className="st-h2 is-plain">{band.title}</h2><p className="st-sub">{band.text}</p><ul className="st-checks">{band.points.map((point) => <Check key={point}>{point}</Check>)}</ul><a className="st-link" href={band.link[1]}>{band.link[0]} <Chevron /></a></Reveal>
            <figure><div className="st-aud-art">{band.visual}</div><figcaption className="st-example-note">{band.caption}</figcaption></figure>
          </div>
        </section>
      ))}
    </SiteShell>
  );
}

function findings(n: Numbers) {
  const leg = (key: string, i: number) => n.view.cards.find((card) => card.key === key)?.legs[i];
  const window = n.view.window;
  return [
    { v: mm(leg("current", 0)?.soilMm ?? null), t: "Winter rain with nothing growing · no cover after corn", href: app("s=current&pg=plan") },
    { v: mm(leg("cover", 0)?.soilMm ?? null), t: "The same winter · cereal rye before soybeans", href: app("s=cover&pg=plan") },
    { v: mm(leg("current", 1)?.soilMm ?? null), t: "Winter rain with nothing growing · no cover after soybeans", href: app("s=current&l=2&pg=plan") },
    { v: mm(leg("cover", 1)?.soilMm ?? null), t: "The same winter · cereal rye before corn", href: app("s=cover&l=2&pg=plan") },
    { v: n.checks == null || n.of == null ? "Not available" : `${n.checks} of ${n.of}`, t: "Springs with a soil-moisture check flagged · rye before soybeans", href: app("s=cover&pg=springs") },
    { v: mm(window?.threshold.value ?? null), t: "Dry-spring cutoff · the 30 days before soybean planting", href: app("pg=springs") },
    { v: mm(window?.median_mm ?? null), t: "Median rainfall · those same 30 days", href: app("pg=springs") },
    { v: n.firstYear == null || n.lastYear == null ? "Not available" : `${n.firstYear}–${n.lastYear}`, t: "Past springs in this saved NASA POWER record", href: app("pg=springs") },
  ];
}

export function EvidencePage() {
  const data = useSiteData();
  const n = useNumbers(data);
  const stories = n ? [
    { key: "current" as const, leg: 0, title: "No planted cover", line: `${whole(n.bareNow)} mm of rain outside living cover in the median winter after corn.`, href: app("s=current&pg=plan") },
    { key: "cover" as const, leg: 0, title: "Cereal rye before soybeans", line: `${whole(n.bareCover)} mm outside living cover in that winter, with a soil-moisture check flagged in ${whole(n.checks)} of ${whole(n.of)} springs.`, href: app("s=cover&pg=plan") },
    { key: "cover" as const, leg: 1, title: "Cereal rye before corn", line: "The winter after soybeans, evaluated against its own planting window.", href: app("s=cover&l=2&pg=plan") },
    { key: "current" as const, leg: 1, title: "No cover after soybeans", line: "The second winter has its own results and denominator. Open it to inspect the record.", href: app("s=current&l=2&pg=plan") },
  ] : [];
  return (
    <SiteShell current="evidence" title={`Evidence & limits · ${APP_NAME}`} springs={n?.springs ?? null}>
      <section className="st-wrap st-page-intro"><p className="st-eyebrow">Evidence & limits</p><h1>A reason behind each option.<span>A source behind each reason.</span></h1><p>Generated rotations bring together your goals, NASA weather history and guidance for the selected location. Read the indicators and uncertainties alongside the shortlist.</p><a className="st-link" href="#union-evidence">Inspect the Union County worked example <Chevron /></a></section>
      <section className="st-wrap st-section"><EvidencePrinciples /></section>
      <section className="st-band" id="union-evidence">
        <div className="st-wrap st-section">
          <div className="st-section-head"><p className="st-eyebrow">Worked example · Union County, North Carolina</p><h2 className="st-h2">A real record to explore.<span>A local example, with local rules.</span></h2><p className="st-sub">Every figure below comes through <span className="st-evidence-source">the planner's saved NASA POWER responses</span>. These are NC corn and soybean plans; their findings do not describe farms elsewhere.</p></div>
          {!n ? <RecordPlaceholder failed={data === null} ratio="3 / 1" /> : null}
          <div className="st-evidence-stories">{stories.map((story) => {
            const plan = n?.view.cards.find((card) => card.key === story.key)?.legs[story.leg]?.plan;
            return <a key={story.title} href={story.href}><div className="st-evidence-picture" aria-hidden="true">{plan?.sequence ? <WinterPicture plan={plan} wide /> : null}</div><div><h3>{story.title}</h3><p>{story.line}</p><span className="st-link">Inspect this winter <Chevron /></span></div></a>;
          })}</div>
          <h3 className="st-find-title">Findings from this example</h3>
          <div className="st-find">{(n ? findings(n) : []).map((finding) => <a key={finding.t} href={finding.href}><p className="st-find-v tabular">{finding.v}</p><p>{finding.t}</p><span className="st-link">See why <Chevron /></span></a>)}</div>
          <p className="st-sub st-find-note">Rainfall is a regional estimate for a NASA grid cell, not a measurement inside the drawn field. The NC check follows NC State's cover-crop timing guidance for soybeans when soil moisture is a concern. Winters are evaluated separately.</p>
          <a className="st-link st-section-link" href="?view=methods">Read the method and source definitions <Chevron /></a>
        </div>
      </section>
      <section className="st-wrap st-section st-limit-note"><h2 className="st-h2">Use the evidence to ask better questions.<span>Keep every single year open.</span></h2><p>An evidence-based outlook shows what to plan for under conditions seen at your field; it cannot say what any single year will bring. Modeled wetness, gridded weather and sourced soil or water indicators have different limits. They do not measure yield, profit or improvements on your farm.</p></section>
    </SiteShell>
  );
}

/* ------------------------------------------------------------------ Resources */
export function ResourcesPage() {
  const data = useSiteData();
  const n = useNumbers(data);
  const list: Array<[string, string, string, string]> = [
    ["Guide", "How it works", "The method in plain steps: windows, thresholds, the two periods and the rules.", "?view=methods"],
    ["Sources", "Data and credits", "Every dataset, guide, library and license, with links.", "?view=credits"],
    ["Policy", "Privacy and terms", "Storage, location requests and the limits of the worked example.", "?view=privacy"],
    ["Sample", "Extension summary", "A printable two-page summary for the Union County sample.", app("v=summary")],
    ["Tour", "Product overview", "The global planning workflow and recordings of the NC worked example.", to("product")],
    ["Record", "Evidence", "The figures the planner reads from the NASA record.", to("evidence")],
  ];
  return (
    <SiteShell current="resources" title={`Resources · ${APP_NAME}`} springs={n?.springs ?? null}>
      <section className="st-rhero">
        <div className="st-wrap">
          <p className="st-small">Resources</p>
          <h1>Guides and sources</h1>
          <a className="btn st-btn-ghost" href="?view=methods">
            Start with how it works <Chevron />
          </a>
          <div className="st-rhero-grid">
            <a className="st-rlead" href="?view=methods">
              <span className="st-read-kind">Guide</span>
              <span className="st-rlead-art" aria-hidden="true" />
              <strong>How {APP_NAME} builds its 10-year outlook and checks plans against the saved NC weather record</strong>
              <span className="st-link is-light">
                Read more <i />
              </span>
            </a>
            <a className="st-rside" href="?view=credits">
              <span className="st-rside-art" aria-hidden="true" />
              <span className="st-read-kind">Sources</span>
              <strong>Data and credits: NASA POWER, NC State Extension and the open libraries behind the planner</strong>
            </a>
          </div>
        </div>
      </section>
      <section className="st-wrap st-section">
        <h2 className="st-h2 is-plain">Everything in one list</h2>
        <ul className="st-rlist">
          {list.map(([kind, title, text, href]) => (
            <li key={title}>
              <a href={href}>
                <span className="st-read-kind">{kind}</span>
                <strong>{title}</strong>
                <span>{text}</span>
                <span className="st-fcard-go" aria-hidden="true">
                  <Arrow />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </SiteShell>
  );
}

/* ------------------------------------------------------------------ About */
export function AboutPage() {
  const data = useSiteData();
  const n = useNumbers(data);
  return (
    <SiteShell current="about" title={`About · ${APP_NAME}`} springs={n?.springs ?? null}>
      <section className="st-wrap st-page-intro">
        <p className="st-eyebrow">{CHALLENGE_LABEL}</p>
        <h1>Built around a field.<span>Grounded in the record.</span></h1>
        <p>{APP_NAME} began as a NASA Space Apps 2026 project in Charlotte. The Union County corn and soybean example remains a record you can explore as the product grows into field-level rotation planning around the world.</p>
        <a className="st-link" href="?view=demo">Explore the original NC example <Chevron /></a>
      </section>
      <section className="st-wrap st-section">
        <h2 className="st-h2">The principles behind the planner.<span>Carried into the next season.</span></h2>
        <EvidencePrinciples />
      </section>
      <section className="st-wrap st-section">
        <h2 className="st-h2">What you bring.<span>What the evidence adds.</span></h2>
        <dl className="st-incl">
          <div><dt>Your field</dt><dd>Location, boundaries, soil context and crop history.</dd></div>
          <div><dt>Your priorities</dt><dd>Goals, crop preferences, equipment and date constraints.</dd></div>
          <div><dt>The observed record</dt><dd>NASA POWER weather, with coverage and resolution limits.</dd></div>
          <div><dt>The local guidance</dt><dd>Sources that apply to the selected region, with gaps kept visible.</dd></div>
        </dl>
      </section>
      <section className="st-wrap st-section st-team">
        <h2 className="st-h2">The team</h2>
        <div className="st-team-grid">
          <div><h3>Frontend</h3><p>Abhi builds the planner experience: the screens, field pictures, map and marketing site.</p></div>
          <div><h3>Backend & data</h3><p>Rahul builds the service: the NASA record, calculations, regional guidance and checks.</p></div>
          <div><h3>A shared rule</h3><p>The frontend displays the service's evidence. Missing values stay missing; every result keeps its source and limits.</p></div>
        </div>
      </section>
    </SiteShell>
  );
}
