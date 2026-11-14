import { APP_NAME } from "../config";
import { CalendarScene, RyeScene, SpringsScene, TourScene } from "./demo/scenes";
import { app, Chevron, Lazy, Reveal, SiteShell, to, useNumbers } from "./Site";
import { EvidencePrinciples, ExampleLink, PlanningPreview, PlanningSteps, RecordFacts, RecordPlaceholder } from "./PlanningStory";
import { useSiteData } from "./useSiteData";

export function Landing() {
  const data = useSiteData();
  const n = useNumbers(data);
  return (
    <SiteShell current="home" title={`${APP_NAME} · Your farm. Your goals. Your future plan.`} springs={n?.springs ?? null}>
      <section className="st-wrap st-global-hero">
        <div className="st-global-hero-copy st-rise">
          <p className="st-eyebrow">Crop rotation planning, wherever you farm</p>
          <h1>Your farm. Your goals.<span>A plan for what comes next.</span></h1>
          <p className="st-hero-description">Find your farm on a map, draw your fields and set your goals. Explore generated crop rotations with explanations, then build a plan for the seasons ahead.</p>
          <div className="st-hero-cta">
            <a className="btn btn-primary" href={app()}>Find your farm</a>
            <a className="btn btn-secondary" href="#watch">Watch the worked example</a>
          </div>
          <p className="st-hero-note">Grounded in {n ? `${n.springs} years` : "decades"} of NASA weather and guidance for your location. Evidence availability varies by region.</p>
        </div>
        <div className="st-rise"><PlanningPreview /></div>
      </section>

      <section className="st-foundation st-wrap" aria-label="Planning inputs">
        <p>Your field is the starting point.</p>
        <ul><li>Location & soil context</li><li>NASA weather history</li><li>Local guidance</li><li>Your goals & constraints</li></ul>
      </section>

      <section className="st-wrap st-section">
        <Reveal className="st-section-head">
          <p className="st-eyebrow">From a field to a future plan</p>
          <h2 className="st-h2">Plan the next rotation.<span>See where it leads.</span></h2>
          <p className="st-sub">A rotation starts with your priorities. Historical weather helps you understand the choices.</p>
        </Reveal>
        <PlanningSteps />
        <a className="st-link st-section-link" href={to("product")}>See how planning works <Chevron /></a>
      </section>

      <section className="st-band st-example-band" id="watch">
        <div className="st-wrap st-section">
          <Reveal className="st-section-head st-example-head">
            <div><p className="st-eyebrow">The worked example · Union County, North Carolina</p><h2 className="st-h2">See the evidence in action.<span>Keep the trade-offs in view.</span></h2></div>
            <div><p className="st-sub">The corn and soybean example replays each plan against the saved NASA record. These recordings use the real planner.</p><a className="st-link" href="?view=demo">Open the NC demo <Chevron /></a></div>
          </Reveal>
          <div className="st-recording">{data ? <TourScene data={data} /> : <RecordPlaceholder failed={data === null} />}</div>
          {n ? <RecordFacts n={n} /> : null}
          <p className="st-example-note">Winter after corn, before soybean planting. Values describe past weather and planned cover, not measured field outcomes.</p>
          <ExampleLink />
        </div>
      </section>

      <section className="st-wrap st-section">
        <Reveal className="st-section-head"><p className="st-eyebrow">Look closer at the worked example</p><h2 className="st-h2">A plan has moving parts.<span>Make each one understandable.</span></h2></Reveal>
        <div className="st-demo-grid">
          {[
            { title: "Explore the timing", text: "Move the rye end date and see how the historical checks change.", href: app("s=cover&pg=rye"), scene: data ? <RyeScene data={data} chrome={false} play="hover" /> : null, ratio: "1180 / 700" },
            { title: "Replay a past spring", text: "Hold the plan steady. Look at the weather from a different year.", href: app("pg=springs"), scene: data ? <SpringsScene data={data} chrome={false} play="hover" /> : null, ratio: "1180 / 700" },
            { title: "Put the work on a calendar", text: "Read the planned harvest, cover and planting dates together.", href: app("pg=calendar"), scene: data ? <CalendarScene data={data} chrome={false} play="hover" /> : null, ratio: "1180 / 690" },
          ].map((card) => <article className="st-demo-card" key={card.title}>
            <div className="st-demo-shot"><Lazy ratio={card.ratio}>{card.scene}</Lazy></div>
            <a href={card.href}><h3>{card.title}</h3><p>{card.text}</p><span className="st-link">Explore in the NC demo <Chevron /></span></a>
          </article>)}
        </div>
      </section>

      <section className="st-wrap st-section">
        <Reveal className="st-section-head"><p className="st-eyebrow">Evidence behind the options</p><h2 className="st-h2">Understand why it made the shortlist.<span>And what still needs a check.</span></h2><p className="st-sub">Compare named indicators, not a single score. Soil and water indicators describe sourced principles, not promised improvements.</p></Reveal>
        <EvidencePrinciples />
        <a className="st-link st-section-link" href={to("evidence")}>Read the evidence and limits <Chevron /></a>
      </section>
    </SiteShell>
  );
}
