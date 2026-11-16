import { useState } from "react";
import type { FieldPlan } from "../../farm/types";
import { CropPicker } from "../../inputs";
import type { Crop } from "../../inputs/schema";
import { updateSimField } from "../../state/simField";
import { hasWinter, worldCropName } from "../../ui/cropNames";
import type { StepContext } from "./context";
import { asTwoCropsAYear, FIT_NOTES, fitResults, leadInCrop, permanentSeason, returnSeason, withCompanion, yearLine } from "./farmSystem";

/*
  Under the crops in step 2 (card 21): the plan said back year by year, the one question a
  repeating plan raises ("do the two crops take turns?"), and "My farm does not fit this" for
  the kinds of farming that cannot be entered yet.
*/
/** The name of a crop as it reads inside a sentence. */
export const cropName = (id: string) => worldCropName(id).toLowerCase();
const capital = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
/** A crop id as the picker's value: the name is the world name, and it is the grower's own choice. */
const asCrop = (id: string | undefined | null): Crop | null => (id ? { crop_id: id, name: worldCropName(id), family: null, roles: [], origin: "grower" } : null);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number) => String(n).padStart(2, "0");

/** One date as two lists, day then month by name (the same way every other date is asked). The value is MM-DD, blank until both are chosen. */
function DayMonth({ label, value, onChange }: { label: string; value: string; onChange: (monthDay: string) => void }) {
  const [month, setMonth] = useState(value ? value.slice(0, 2) : "");
  const [day, setDay] = useState(value ? value.slice(3) : "");
  const commit = (m: string, d: string) => {
    setMonth(m);
    setDay(d);
    onChange(m && d ? `${m}-${d}` : "");
  };
  return (
    <fieldset className="acre-input-date">
      <legend>{label}</legend>
      <div className="acre-input-date-row">
        <select aria-label={`${label}: day`} value={day} onChange={(e) => commit(month, e.target.value)}>
          <option value="">Day</option>
          {Array.from({ length: 28 }, (_, i) => (
            <option key={i} value={two(i + 1)}>
              {i + 1}
            </option>
          ))}
        </select>
        <select aria-label={`${label}: month`} value={month} onChange={(e) => commit(e.target.value, day)}>
          <option value="">Month</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={two(i + 1)}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <p className="acre-input-help">{month && day ? `${Number(day)} ${MONTHS[Number(month) - 1]}, every year.` : "Pick the day and the month. Any day in the month you usually finish harvesting will do."}</p>
    </fieldset>
  );
}

/**
 * A season under a crop that stays in the ground (trees, sugarcane, tea, pasture): shown in
 * place of the three crop boxes. There is nothing to plant, so the only date is the harvest.
 */
export function PermanentSeason({ plan, show, onChange, onYearly }: { plan: FieldPlan; show: "all" | "crops" | "dates"; onChange: (p: FieldPlan) => void; onYearly: () => void }) {
  const sold = plan.permanent?.sold ?? true;
  const name = cropName(plan.next_crop_id);
  return (
    <section className="gf-perm" aria-label={`${capital(name)}, in the ground all year`}>
      {show !== "dates" ? (
        <>
          <h3>{capital(name)}</h3>
          <p>Stays in the ground all year. Nothing is planted each season and the ground is never bare.</p>
          <div className="gf-fit-actions" role="group" aria-label="Is a harvest sold from it every year?">
            <button type="button" className="btn btn-secondary" aria-pressed={sold} onClick={() => onChange(permanentSeason(plan.next_crop_id, true, sold ? plan.prev_harvest : ""))}>
              I sell a harvest every year
            </button>
            <button type="button" className="btn btn-secondary" aria-pressed={!sold} onClick={() => onChange(permanentSeason(plan.next_crop_id, false))}>
              Nothing is sold from it
            </button>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onYearly}>
            Change back to crops planted every year
          </button>
        </>
      ) : null}
      {show !== "crops" ? (
        sold ? (
          <>
            {show === "dates" ? <h3>{capital(name)}</h3> : null}
            <DayMonth label="Harvest date" value={plan.prev_harvest} onChange={(d) => onChange(permanentSeason(plan.next_crop_id, true, d))} />
          </>
        ) : (
          <p className="gf-muted">{capital(name)}: no dates are needed, because nothing is planted or sold.</p>
        )
      ) : null}
    </section>
  );
}

export function FarmFit({ ctx, rotation, onChange }: { ctx: StepContext; rotation: FieldPlan[]; onChange: (r: FieldPlan[]) => void }) {
  const { field, sim, point } = ctx;
  if (!field) return null;
  const line = yearLine(rotation, cropName);
  const leadIn = leadInCrop(rotation);
  const back = returnSeason(rotation);
  const last = rotation[rotation.length - 1];
  const ticked = sim.fitNotes ?? [];
  const toggle = (id: string) => updateSimField(field.field_id, { fitNotes: ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id] });
  const winter = hasWinter(point?.latitude);
  const first = rotation[0];
  /** Two harvests a year: the plan is rearranged, and each date keeps the label saying where it came from. */
  const makeTwoAYear = () => {
    if (!first) return;
    const next = asTwoCropsAYear(first);
    const moved = first.winter.kind !== "winter_grain" && next.winter.kind === "winter_grain" && Boolean(next.winter.crop_id);
    updateSimField(field.field_id, (cur) => {
      const saved = cur.planInputs?.[first.plan_id];
      if (!saved) return {};
      // The second crop's planting date was the "next crop" date; the old in-between dates no longer apply.
      const dates = moved ? saved.dates.flatMap((d) => (d.field === "next_plant" ? [{ ...d, field: "winter.plant" as const }] : d.field.startsWith("winter.") ? [] : [d])) : saved.dates;
      return { planInputs: { ...cur.planInputs, [first.plan_id]: { ...saved, dates } } };
    });
    onChange([next]);
  };
  const twoAYear = rotation.length === 1 && first?.winter.kind === "winter_grain" && first.previous_crop_id === first.next_crop_id;
  const api = ctx.api.client.inputs;
  const regionKey = ctx.regionKey ?? "";
  // The long-lived crop being chosen, before it replaces the plan.
  const [tree, setTree] = useState<Crop | null>(null);
  const [treeSold, setTreeSold] = useState(true);
  const yearly = rotation.filter((p) => !p.permanent && p.next_crop_id);
  const allPermanent = rotation.length > 0 && rotation.every((p) => p.permanent);
  return (
    <div className="gf-fit">
      {line ? (
        <section className="gf-fit-years" aria-label="What will be simulated">
          <h3>What will be simulated</h3>
          <p className="gf-fit-line">{line}</p>
          {leadIn && back && last ? (
            <div className="gf-fit-ask" role="group" aria-label={`After ${cropName(last.next_crop_id)}`}>
              <p>
                {capital(cropName(leadIn))} is only what was on the field before the first year. As entered, it is not grown again.
              </p>
              <p className="gf-fit-q">Do {cropName(leadIn)} and {cropName(last.next_crop_id)} take turns on this field?</p>
              <div className="gf-fit-actions">
                <button type="button" className="btn btn-secondary" onClick={() => onChange([...rotation, back])}>
                  Yes, grow {cropName(leadIn)} again after {cropName(last.next_crop_id)}
                </button>
                {rotation.length === 1 ? (
                  <button type="button" className="btn btn-secondary" onClick={makeTwoAYear}>
                    I grow both every year
                  </button>
                ) : null}
              </div>
              <p className="gf-muted">Leave it as it is if you grow {cropName(last.next_crop_id)} every year from now on.</p>
            </div>
          ) : null}
        </section>
      ) : null}
      <details className="gf-fit-more">
        <summary>My farm does not fit this</summary>
        <p>
          A.C.R.E follows one field and one crop after another, up to two harvests a year. {winter ? "A winter crop you harvest counts as the second one." : "A second rainy season counts as the second one."} If
          your field is farmed another way, set it up here. The results say plainly what they do not cover.
        </p>
        {!twoAYear && first && rotation.length === 1 && !allPermanent ? (
          <div className="gf-fit-case">
            <strong>I harvest two crops a year here</strong>
            <span className="gf-muted">{winter ? "A summer crop and a winter crop, both sold." : "One crop in each rainy season, both sold."}</span>
            <p>Put your main crop as both the first and the next crop, and the other one in between as “Another crop you harvest”. Both are counted.</p>
            <button type="button" className="btn btn-secondary" onClick={makeTwoAYear}>
              Set it up that way
            </button>
          </div>
        ) : null}
        {yearly.length ? (
          <div className="gf-fit-case">
            <strong>Two crops grow together in the same field</strong>
            <span className="gf-muted">Maize with beans, sorghum with cowpea, a crop between young trees.</span>
            <p>Name the crop that grows with your main crop. It is sold and paid for in the same season. What it adds to soil cover is not worked out.</p>
            {rotation.map((p, i) =>
              p.permanent || !p.next_crop_id ? null : (
                <div key={p.plan_id} className="gf-fit-mate">
                  <CropPicker changeLabel="Change crop" label={`Grown together with ${cropName(p.next_crop_id)}${rotation.length > 1 ? ` (season ${i + 1})` : ""}`} regionKey={regionKey} api={api} value={asCrop(p.companions?.[0])} onChange={(crop) => onChange(rotation.map((x, j) => (j === i ? withCompanion(x, crop?.crop_id ?? null) : x)))} />
                  {p.companions?.length ? (
                    <button type="button" className="btn btn-quiet" onClick={() => onChange(rotation.map((x, j) => (j === i ? withCompanion(x, null) : x)))}>
                      Remove {cropName(p.companions[0]!)}
                    </button>
                  ) : null}
                </div>
              ),
            )}
          </div>
        ) : null}
        {!allPermanent ? (
          <div className="gf-fit-case">
            <strong>A crop that stays in the ground for years</strong>
            <span className="gf-muted">Coffee, tea, banana, cocoa, fruit trees, sugarcane, pasture or hay.</span>
            <p>Nothing is planted each year and the ground is never bare, so rain on bare ground and dry planting time do not apply. Its harvest and money are your own numbers; weather is not used to change them.</p>
            <CropPicker changeLabel="Change crop" label="The long-lived crop" regionKey={regionKey} api={api} value={tree} onChange={setTree} />
            <div className="gf-fit-actions" role="group" aria-label="Is a harvest sold from it every year?">
              <button type="button" className="btn btn-secondary" aria-pressed={treeSold} onClick={() => setTreeSold(true)}>
                I sell a harvest every year
              </button>
              <button type="button" className="btn btn-secondary" aria-pressed={!treeSold} onClick={() => setTreeSold(false)}>
                Nothing is sold (grazing)
              </button>
            </div>
            <button type="button" className="btn btn-secondary" disabled={!tree} onClick={() => tree && onChange([permanentSeason(tree.crop_id, treeSold)])}>
              {tree ? `This whole field is ${cropName(tree.crop_id)}` : "Pick the crop first"}
            </button>
          </div>
        ) : null}
        {FIT_NOTES.map((n) => (
          <label key={n.id} className="gf-fit-case">
            <span className="gf-fit-tick">
              <input type="checkbox" checked={ticked.includes(n.id)} onChange={() => toggle(n.id)} />
              <strong>{n.title}</strong>
            </span>
            <span className="gf-muted">{n.example}</span>
            <p>{n.enter}</p>
          </label>
        ))}
        <p className="gf-muted">A whole year with no crop cannot be entered yet. For a short rest between crops, choose “Nothing (bare or stubble)”.</p>
      </details>
    </div>
  );
}

/** One line on a result for each thing the grower said the plan leaves out. */
export function FitCaution({ ids, notes }: { ids: readonly string[] | undefined; /** What the service says its result covers for crops grown together or ground that stays planted. */ notes?: ReadonlyArray<{ text: string }> }) {
  const lines = [...(notes ?? []).map((n) => n.text), ...fitResults(ids)];
  if (!lines.length) return null;
  return (
    <div className="gf-fit-caution" role="note">
      <strong>How to read these results</strong>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
