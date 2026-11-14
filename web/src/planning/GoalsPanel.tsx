import { useEffect, useId, useState } from "react";
import { equipmentIds, priorityIds, type Goals } from "./api";
import "./planning.css";
export interface GoalsPanelValue {
  goals: Goals;
  crop_history: string[];
}
export interface GoalsPanelProps {
  value: GoalsPanelValue;
  onChange: (value: GoalsPanelValue) => void;
}
export function createGoalsPanelValue(): GoalsPanelValue {
  return {
    goals: {
      priorities: {
        soil_cover: 3,
        water_conservation: 2,
        weather_resilience: 0,
        crop_diversity: 1,
        living_cover_duration: 2,
        management_simplicity: 1
      },
      constraints: {
        allowed_crops: null,
        excluded_crops: [],
        must_include: [],
        irrigation: "unknown",
        equipment: [],
        latest_planting: null,
        earliest_harvest: null,
        seasons: 2
      },
      preferences: {
        liked_crops: [],
        disliked_crops: []
      }
    },
    crop_history: []
  };
}
export const priorityLabels = {
  soil_cover: "Soil cover",
  water_conservation: "Water conservation",
  weather_resilience: "Weather resilience",
  crop_diversity: "Crop diversity",
  living_cover_duration: "Living cover duration",
  management_simplicity: "Management simplicity"
};
const equipmentLabels: Record<typeof equipmentIds[number], string> = {
  no_drill_interseeding: "No drill interseeding",
  no_roller_crimper: "No roller crimper",
  no_no_till_planter: "No no-till planter",
  no_grain_drill: "No grain drill",
  no_sprayer: "No sprayer"
};
const crops = ["field_corn", "soybean", "cereal_rye", "winter_wheat", "oats", "sorghum", "barley", "winter_barley", "hairy_vetch", "crimson_clover"];
const list = (text: string) => text.split(",").map(s => s.trim()).filter(Boolean);
function CropInput({
  label,
  value,
  onChange,
  hint,
  id
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  hint?: string;
  id: string;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  const hintId = useId();
  const signature = value.join("\0");
  // Retain separators as the grower types while still reporting every change to the parent.
  useEffect(() => {
    setDraft(current => list(current).join("\0") === signature ? current : value.join(", "));
  }, [signature, value]);
  return <label className="pl-input-label">{label}<input aria-label={label} aria-describedby={hint ? hintId : undefined} value={draft} list={id} placeholder="Crop IDs, separated by commas" onChange={e => {
      setDraft(e.currentTarget.value);
      onChange(list(e.currentTarget.value));
    }} />{hint && <small id={hintId}>{hint}</small>}</label>;
}
export function GoalsPanel({
  value,
  onChange
}: GoalsPanelProps) {
  const id = useId();
  const {
    goals,
    crop_history
  } = value;
  const constraints = (patch: Partial<Goals["constraints"]>) => onChange({
    ...value,
    goals: {
      ...goals,
      constraints: {
        ...goals.constraints,
        ...patch
      }
    }
  });
  const preferences = (patch: Partial<Goals["preferences"]>) => onChange({
    ...value,
    goals: {
      ...goals,
      preferences: {
        ...goals.preferences,
        ...patch
      }
    }
  });
  return <div className="pl pl-goals">
    <datalist id={id}>{crops.map(c => <option key={c} value={c} />)}</datalist>
    <section className="pl-card pl-priorities" aria-labelledby={`${id}-priorities`}>
      <h2 id={`${id}-priorities`}>What matters to you?</h2><p className="pl-muted">0 = no preference · 1 = some · 2 = high · 3 = highest</p>
      <div className="pl-priority-grid">{priorityIds.map(key => <label className="pl-slider" key={key}><span>{priorityLabels[key]}<output>{goals.priorities[key]}</output></span><input type="range" min={0} max={3} step={1} value={goals.priorities[key]} aria-label={priorityLabels[key]} aria-valuetext={`${goals.priorities[key]} of 3`} onChange={e => onChange({
            ...value,
            goals: {
              ...goals,
              priorities: {
                ...goals.priorities,
                [key]: Number(e.target.value)
              }
            }
          })} /><span className="pl-range-ends"><small>No preference</small><small>Highest</small></span></label>)}</div>
    </section>
    <section className="pl-card" aria-labelledby={`${id}-constraints`}>
      <h2 id={`${id}-constraints`}>Hard constraints</h2><p className="pl-muted">Plans must meet these limits. Leave an unknown limit open.</p>
      <div className="pl-form-grid">
        <CropInput id={id} label="Allowed crops" value={goals.constraints.allowed_crops ?? []} onChange={v => constraints({
          allowed_crops: v.length ? v : null
        })} hint="Blank = any crop supported by the regional catalog." />
        <CropInput id={id} label="Excluded crops" value={goals.constraints.excluded_crops} onChange={v => constraints({
          excluded_crops: v
        })} />
        <CropInput id={id} label="Must include crops" value={goals.constraints.must_include} onChange={v => constraints({
          must_include: v
        })} />
        <label className="pl-input-label">Irrigation<select value={goals.constraints.irrigation} onChange={e => constraints({
            irrigation: e.target.value as Goals["constraints"]["irrigation"]
          })}><option value="unknown">Unknown / not reported</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label className="pl-input-label">Latest planting<input type="text" placeholder="MM-DD or blank" pattern="[0-9]{2}-[0-9]{2}" value={goals.constraints.latest_planting ?? ""} onChange={e => constraints({
            latest_planting: e.target.value || null
          })} /></label>
        <label className="pl-input-label">Earliest harvest<input type="text" placeholder="MM-DD or blank" pattern="[0-9]{2}-[0-9]{2}" value={goals.constraints.earliest_harvest ?? ""} onChange={e => constraints({
            earliest_harvest: e.target.value || null
          })} /></label>
        <label className="pl-input-label">Seasons<select value={goals.constraints.seasons} onChange={e => constraints({
            seasons: Number(e.target.value)
          })}>{[1, 2, 3, 4].map(n => <option value={n} key={n}>{n}</option>)}</select></label>
      </div>
      <fieldset className="pl-equipment"><legend>Equipment limitations</legend>{equipmentIds.map(key => <label key={key}><input type="checkbox" checked={goals.constraints.equipment.includes(key)} onChange={e => constraints({
            equipment: e.target.checked ? [...goals.constraints.equipment, key] : goals.constraints.equipment.filter(k => k !== key)
          })} />{equipmentLabels[key]}</label>)}<small>No selection = no limitations reported.</small></fieldset>
    </section>
    <div className="pl-two-col">
      <section className="pl-card" aria-labelledby={`${id}-preferences`}><h2 id={`${id}-preferences`}>Crop preferences</h2><p className="pl-muted">These influence the options; they do not exclude a plan.</p><div className="pl-form-stack"><CropInput id={id} label="Liked crops" value={goals.preferences.liked_crops} onChange={v => preferences({
            liked_crops: v
          })} /><CropInput id={id} label="Disliked crops" value={goals.preferences.disliked_crops} onChange={v => preferences({
            disliked_crops: v
          })} /></div></section>
      <section className="pl-card" aria-labelledby={`${id}-history`}><h2 id={`${id}-history`}>Crop history</h2><div className="pl-form-stack"><CropInput id={id} label="Previous crops" value={crop_history} onChange={v => onChange({
            ...value,
            crop_history: v
          })} hint="Up to 3 crops, oldest first. Blank = not reported." /></div></section>
    </div>
  </div>;
}
