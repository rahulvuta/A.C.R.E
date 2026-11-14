import { useState } from "react";
import type { RegionProfile } from "../../api/model";
import { farmActions } from "../../farm/hooks";
import type { Field } from "../../farm/types";
import { OriginBadge } from "../../ui/OriginBadge";

/*
  Regional suggestions (card D3): the profile's rules, covers and rotations with their sources,
  conflicts and gaps. AI rows are never styled as verified. "Use as my practice" copies a cover
  into the field plan marked `grower`; "Dismiss" hides a row for this session.
*/
export function ResearchPanel({ profile, field }: { profile: RegionProfile; field: Field | null }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<string | null>(null);
  const hide = (id: string) => setHidden((h) => new Set(h).add(id));
  const verified = profile.status === "complete" && profile.rules.every((r) => r.origin === "verified_source");

  const useCover = (cropId: string, name: string) => {
    if (!field) return;
    const base = field.plan;
    if (!base) {
      setDone(`Make a plan for ${field.name} first, then use ${name} as its cover.`);
      return;
    }
    const w = base.winter.kind === "cover" ? base.winter : { kind: "cover" as const, crop_id: cropId, seed: "", terminate: "" };
    farmActions.setFieldPlan(field.field_id, { ...base, winter: { ...w, crop_id: cropId }, origins: { ...base.origins, winter: "grower" } });
    setDone(`${name} is now the cover in ${field.name}'s plan, marked as your practice.`);
  };

  return (
    <section className="db-card rp" aria-label="Regional guidance">
      <div className="db-card-head">
        <h2>{verified ? "Published guidance for this region" : "Suggestions for this region"}</h2>
        {!verified && profile.disclaimer ? <p>{profile.disclaimer}</p> : null}
      </div>
      {done ? <p role="status" className="rp-done">{done}</p> : null}
      {profile.covers.filter((c) => !hidden.has(`c:${c.cropId}`)).length ? (
        <>
          <h3>Cover crops</h3>
          <ul className="rp-list">
            {profile.covers
              .filter((c) => !hidden.has(`c:${c.cropId}`))
              .map((c) => (
                <li key={c.cropId} data-origin={c.origin}>
                  <span>{c.name}</span> <OriginBadge origin={c.origin} />
                  {c.sources.map((s) => (s.url ? <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : <span key={s.title}>{s.title}</span>))}
                  <span className="rp-acts">
                    <button type="button" className="btn btn-small btn-secondary" onClick={() => useCover(c.cropId, c.name)} disabled={!field}>
                      Use as my practice
                    </button>
                    <button type="button" className="btn btn-small btn-quiet" onClick={() => hide(`c:${c.cropId}`)}>
                      Dismiss
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </>
      ) : null}
      {profile.rules.filter((r) => !hidden.has(`r:${r.ruleId}`)).length ? (
        <>
          <h3>Guidance</h3>
          <ul className="rp-list">
            {profile.rules
              .filter((r) => !hidden.has(`r:${r.ruleId}`))
              .map((r) => (
                <li key={r.ruleId} data-origin={r.origin}>
                  <span>{r.text}</span> <OriginBadge origin={r.origin} />
                  {r.evidenceQuote ? <q className="rp-quote">{r.evidenceQuote}</q> : null}
                  {r.source ? r.source.url ? <a href={r.source.url} target="_blank" rel="noreferrer">{r.source.title}</a> : <span>{r.source.title}</span> : null}
                  {r.conflictsWith.length ? <span className="rp-conflict">Conflicts with {r.conflictsWith.join(", ")}</span> : null}
                  {r.limitations ? <span className="rp-lim">{r.limitations}</span> : null}
                  <span className="rp-acts">
                    <button type="button" className="btn btn-small btn-quiet" onClick={() => hide(`r:${r.ruleId}`)}>
                      Dismiss
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </>
      ) : null}
      {profile.rotations.length ? (
        <>
          <h3>Rotations seen here</h3>
          <ul className="rp-list">
            {profile.rotations.map((r) => (
              <li key={r.label} data-origin={r.origin}>
                <span>{r.label}</span> <OriginBadge origin={r.origin} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {profile.gaps.length ? (
        <>
          <h3>Not found yet</h3>
          <ul className="rp-gaps">
            {profile.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
