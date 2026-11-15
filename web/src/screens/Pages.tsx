import type { CSSProperties, ReactNode } from "react";
import { APP_NAME, CHALLENGE_LABEL } from "../config";
import { DATA_CREDITS, DISCLOSURES, LIBRARIES } from "../content/credits";
import { GLOSSARY } from "../content/glossary";
import { SOURCES } from "../content/strategies";
import { Reveal, SiteShell, useNumbers } from "../site/Site";
import { useSiteData } from "../site/useSiteData";

/*
  Methods (card 6.4), Credits (card 6.5) and Privacy. Reading pages inside the site's own
  nav and footer, so a judge can explain the method back and see every source, license and
  disclosure. Each topic is a row across the page: heading on the left, text on the right,
  lists and definitions in two columns. The back link returns to the planner state the
  reader came from.
*/

function backToPlanner(e: React.MouseEvent<HTMLAnchorElement>) {
  if (document.referrer && new URL(document.referrer).origin === window.location.origin && window.history.length > 1) {
    e.preventDefault();
    window.history.back();
  }
}

function DocPage({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  const n = useNumbers(useSiteData());
  return (
    <SiteShell current="resources" title={`${title} · ${APP_NAME}`} springs={n?.springs ?? null}>
      <section className="st-hero st-wrap">
        <p className="st-eyebrow st-rise">{CHALLENGE_LABEL}</p>
        <div className="st-hero-head">
          <h1 className="st-rise" style={{ "--d": "60ms" } as CSSProperties}>
            {title}
          </h1>
          <div className="st-hero-side st-rise" style={{ "--d": "140ms" } as CSSProperties}>
            <p>{lede}</p>
            <a className="st-link" href="?view=app" onClick={backToPlanner}>
              Back to the planner <i />
            </a>
          </div>
        </div>
      </section>
      <div className="st-wrap st-doc">{children}</div>
    </SiteShell>
  );
}

/** One topic: its heading stays on the left while its text spreads across the right. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Reveal as="section" className="st-doc-row">
      <h2 id={id}>{title}</h2>
      <div className="st-doc-body">{children}</div>
    </Reveal>
  );
}

export function MethodsPage() {
  return (
    <DocPage
      title="How A.C.R.E works"
      lede="A.C.R.E gives an evidence-based outlook: it carries a grower's crop plans through the next 10 years using what has been observed at their field, to show what to plan for and which plan holds up better. It cannot say what any single year will bring or measure a field."
    >
      <Section id="m-outlook" title="The 10-year outlook">
        <p>
          For any field you draw, A.C.R.E builds an evidence-based outlook: based on what has happened at this field, this is what to plan
          for. It is not 100% predictive of what will happen. It shows how each plan would do under conditions already observed here and
          the change we expect from the trend in that record, so we can say "we think this plan is better than that one".
        </p>
        <ul>
          <li>
            <strong>The evidence.</strong> The seasons actually observed at this field, 1981 to 2025, from NASA weather data for the
            surrounding grid cell (about 50 km across), not a measurement taken on the field itself.
          </li>
          <li>
            <strong>The method.</strong> Each plan is run through the next 10 years about 200 times. Every run uses those real seasons
            in a different order, and every plan gets the same sequences, so the comparison is fair. The bad-year and good-year range
            shows how far results spread across the runs.
          </li>
          <li>
            <strong>The climate trend.</strong> When this field's own record shows a statistically clear trend in yearly rain, rain is
            adjusted for it. When the trend is not clear, rain is used as recorded. Temperature trends are shown as context and do not
            change the results.
          </li>
          <li>
            <strong>The money.</strong> Prices, yields and costs are the ones you entered or that came from published sources, held at
            today's values. Where nothing is published in our tables, the app may fill blanks with figures AI found on an official page and the code then
            checked against that page, labelled &ldquo;AI-found, quote checked&rdquo;; finds it could not check are only offered as suggestions you can accept. Weather changes the money only through a loss estimate you enter, labelled as an assumption.
          </li>
          <li>
            <strong>What it can tell you.</strong> What to plan for, and which plan holds up better in most of the simulated years.
          </li>
          <li>
            <strong>What it cannot tell you.</strong> What any single year will bring. It does not measure soil moisture, crop growth or
            yield, and it compares the plans you give it, not every possible plan.
          </li>
        </ul>
        <p>The sections below describe the Union County, North Carolina winter-cover check in detail.</p>
      </Section>

      <Section id="m-question" title="The question it answers">
        <p>
          A corn grower in the North Carolina Piedmont is planning soybeans. Over winter they can leave no planted cover, plant cereal rye
          as a cover crop, or grow winter wheat for grain. Rye protects the soil but uses water while it grows, so in a dry spring ending
          it too close to planting can leave the seedbed dry. A.C.R.E shows how each plan would have fared across every past spring on
          record for this area.
        </p>
      </Section>

      <Section id="m-data" title="The weather data">
        <ul>
          <li>
            NASA POWER daily estimates for a reference point near Monroe, Union County, NC: corrected precipitation (PRECTOTCORR) and
            root-zone soil wetness (GWETROOT, from the MERRA-2 model), 1981 to 2025.
          </li>
          <li>Values describe a grid cell roughly 50 km across, not one farm. Local storms can make a field wetter or drier.</li>
          <li>The record is saved with the app, so the comparison works offline. The screen says when data is a saved record, live, or draft.</li>
          <li>A day with no rain counts as 0.0 mm. A missing day makes that spring incomplete; incomplete springs are left out and listed.</li>
        </ul>
      </Section>

      <Section id="m-window" title="The planting window">
        <p>
          For each plan, the window is the 30 days ending the day before planting. For soybeans on May 12 that is April 12 to May 11, in
          every year from 1981 to 2025. Moving the rye end date does not move this window; changing the planting date does. Double-crop
          soybeans after wheat have their own June window.
        </p>
      </Section>

      <Section id="m-rank" title="Ranking springs and the driest 20%">
        <ul>
          <li>Each complete spring is ranked by its 30-day rainfall; rank 1 is the driest.</li>
          <li>
            The dry cutoff is the 20th percentile of complete springs for that window, computed once and shared by every plan. Springs at or
            below it are labeled among the driest 20%. Ties at the cutoff count as dry.
          </li>
          <li>With fewer than 15 complete springs, A.C.R.E withholds the typical, dry and rank labels and shows only the record.</li>
          <li>This 20% line is a label for comparing past years, not a drought declaration.</li>
        </ul>
      </Section>

      <Section id="m-check" title="The field-moisture check">
        <p>
          NC State Extension suggests ending a cover crop at least two weeks before soybean planting if low soil moisture is a concern (
          <a href={SOURCES["ncs-soy-4"].url} target="_blank" rel="noreferrer">
            NC Soybean Production Guide, ch. 4
          </a>
          ). A.C.R.E flags a spring when the gap between ending rye and planting is under 14 days and either that spring was in the
          driest 20% or the grower reported a moisture concern. The 20% line and the 14-day guidance are separate thresholds from
          separate sources.
        </p>
        <p>
          A flag means "check your field moisture before keeping rye this close to planting", not "the field was dry". It does not apply
          to plans without a cover crop to end.
        </p>
      </Section>

      <Section id="m-winter" title="Rain on ground with no living cover">
        <p>
          For each winter from corn harvest to planting, A.C.R.E adds up the rain that fell on days with no planned living cover, and
          shows the median across winters. It measures rain and calendar overlap, not erosion: crop residue may still cover the ground,
          and actual cover depends on how the crop established. A heavy-rain day count will be added once its definition is confirmed.
        </p>
      </Section>

      <Section id="m-eras" title="Earlier vs recent">
        <p>
          Counts are compared between 1981–2000 and 2006–2025, with the same cutoff in both. 2001–2005 stays in the full record but in
          neither period. Each period needs at least 15 of its 20 springs. "About as often" means the two periods differ by less than 10
          percentage points. This describes two periods only; it does not show a trend or a cause, and it cannot say what any single spring will bring.
        </p>
      </Section>

      <Section id="m-3d" title="The 3D farm view">
        <p>
          An illustration of the planned dates. Crops appear and end on each plan's dates, rain falls only in each field's 30 days before
          planting, and soil color and the water line show modeled soil wetness. Plant heights are stages, not measured growth.
        </p>
      </Section>

      <Section id="m-ground" title="Satellites and models vs. your field">
        <p>
          NASA's estimates show what the region around the grid point was like. A soil check in your own field tells you what your
          seedbed is like this year. A.C.R.E keeps the two apart: your own report is labeled as yours, and it can trigger the NC State
          guidance on its own.
        </p>
      </Section>

      <Section id="m-limits" title="What A.C.R.E does not claim">
        <ul>
          <li>It cannot say what any single year, or next spring, will bring.</li>
          <li>It does not measure soil moisture, crop growth, erosion or yield on your field.</li>
          <li>It does not estimate water savings, costs or profit, and does not name a "best" rotation.</li>
          <li>Wheat planting and harvest windows are not yet sourced, so that timing check shows unknown.</li>
          <li>The second winter of each two-year rotation (soybeans to corn) is not evaluated yet.</li>
        </ul>
        <p>
          <strong>It supports, not replaces, local advice.</strong> Take the comparison to your NC State Extension agent before changing a
          plan.
        </p>
      </Section>

      <Section id="m-glossary" title="Words used on the screen">
        <dl className="st-doc-terms">
          {Object.values(GLOSSARY).map((g) => (
            <div key={g.term}>
              <dt>{g.term}</dt>
              <dd>{g.definition}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </DocPage>
  );
}

export function CreditsPage() {
  return (
    <DocPage
      title="Credits and disclosures"
      lede="Everything A.C.R.E uses, where it comes from, and what to know about how it was built."
    >
      <Section id="c-data" title="Data and guidance">
        <ul className="st-doc-credits">
          {DATA_CREDITS.map((d) => (
            <li key={d.name}>
              <a href={d.url} target="_blank" rel="noreferrer">
                {d.name}
              </a>{" "}
              · {d.owner}
              <p>{d.used}</p>
              {d.note ? <p className="st-doc-note">{d.note}</p> : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="c-code" title="Open-source code and fonts">
        <div className="table-scroll st-doc-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Package</th>
                <th scope="col">Version</th>
                <th scope="col">License</th>
                <th scope="col">Used for</th>
              </tr>
            </thead>
            <tbody>
              {LIBRARIES.map((l) => (
                <tr key={l.name}>
                  <th scope="row">{l.name}</th>
                  <td>{l.version}</td>
                  <td>{l.license}</td>
                  <td>{l.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="st-doc-note">
          Source code:{" "}
          <a href="https://github.com/abhijandyala/sa2026" target="_blank" rel="noreferrer">
            github.com/abhijandyala/sa2026
          </a>
        </p>
      </Section>

      <Section id="c-disclose" title="Disclosures">
        <dl className="st-doc-terms">
          {DISCLOSURES.map((d) => (
            <div key={d.title}>
              <dt>{d.title}</dt>
              <dd>{d.text}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </DocPage>
  );
}

export function PrivacyPage() {
  return (
    <DocPage
      title="Privacy and terms"
      lede="What A.C.R.E keeps, what it sends and to whom, and the terms for using what it shows."
    >
      <Section id="p-keep" title="What A.C.R.E keeps">
        <p>
          Nothing about you on any server. There are no accounts, no cookies and no analytics. Farms you draw (their boundaries,
          field names, plans and goals) are saved only in this browser's local storage, and you can export or delete them at any
          time. The Union County demo keeps nothing.
        </p>
      </Section>
      <Section id="p-send" title="What is sent, and where">
        <ul>
          <li>The Union County sample is stored with this site. Opening it sends nothing anywhere.</li>
          <li>
            When the live service is connected, applying dates sends your plan dates to it so it can check them against past
            springs. Choosing another place sends that place's coordinates so it can find the NASA POWER grid cell.
          </li>
          <li>
            Analysing a farm sends its field boundaries and plans to the A.C.R.E service, which measures them and answers. The
            service does not store or log boundaries or coordinates.
          </li>
          <li>Searching or clicking the map sends the place name or point to the service to find where it is.</li>
          <li>The service asks NASA for the grid cell's center, not your exact point.</li>
          <li>AI research on regional guidance, and the lookup of missing prices, yields and costs, receives only the crop and the region (country, state or province, climate class), never your fields, coordinates or numbers.</li>
          <li>Shared links hold view choices only (plan, year, winter, priorities, listed place). Never your dates or typed coordinates.</li>
        </ul>
      </Section>
      <Section id="p-terms" title="Terms of use">
        <ul>
          <li>
            A.C.R.E gives an evidence-based outlook, built from past weather, to support a conversation with your Extension agent. It cannot say what any single year will bring, is not a field
            measurement or professional advice, and makes no promise about yields, costs or outcomes.
          </li>
          <li>It is provided as is, without warranty, as a NASA Space Apps Challenge 2026 project.</li>
          <li>
            NASA does not endorse A.C.R.E. NASA POWER data is used under NASA's open data terms; NC State Extension guidance is
            linked to its source and summarized, not copied.
          </li>
          <li>Every source and library, with its license, is listed on the Credits page.</li>
        </ul>
      </Section>
    </DocPage>
  );
}
