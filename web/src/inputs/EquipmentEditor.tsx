import { useCallback, useState } from "react";
import { inputsApi, type InputsApi } from "./api";
import { ErrorNotice, OriginLabel, readable, useInputRequest } from "./shared";

export interface EquipmentEditorProps { value: string[]; onChange: (value: string[]) => void; api?: InputsApi }
export function EquipmentEditor({ value, onChange, api = inputsApi }: EquipmentEditorProps) {
  const loader = useCallback((signal: AbortSignal) => api.equipment(signal), [api]);
  const request = useInputRequest("equipment", loader);
  const [other, setOther] = useState("");
  const otherValid = /^[\w .,/()+-]{1,40}$/.test(other.trim());
  const known = request.data?.equipment.filter(item => item.id !== "other" && !item.id.startsWith("other:")) ?? [];
  const extras = value.filter(id => !known.some(item => item.id === id));
  return <section className="acre-inputs acre-input-card" aria-label="Equipment"><h2>Equipment you can use</h2><p>Check equipment you own or can hire. Leaving it unchecked does not confirm it is unavailable.</p>
    {request.loading && <p role="status">Loading equipment choices…</p>}{request.error && <ErrorNotice error={request.error} retry={request.retry} />}
    <fieldset><legend>Available equipment <OriginLabel origin="grower" /></legend><div className="acre-input-checklist">{known.map(item => <label key={item.id}><input type="checkbox" checked={value.includes(item.id)} onChange={event => onChange(event.target.checked ? [...new Set([...value, item.id])] : value.filter(id => id !== item.id))} />{item.label}</label>)}</div>
      {!request.loading && !request.error && !known.length && <p>Equipment choices: Not available. Add equipment below.</p>}
    </fieldset>
    {!!extras.length && <ul className="acre-input-other-list">{extras.map(id => <li key={id}><span>{id.startsWith("other:") ? id.slice(6) : readable(id)}</span><OriginLabel origin="grower" /><button type="button" onClick={() => onChange(value.filter(item => item !== id))}>Remove {id.startsWith("other:") ? id.slice(6) : readable(id)}</button></li>)}</ul>}
    <div className="acre-input-inline"><label>Other equipment<input value={other} placeholder="Equipment name" maxLength={40} onChange={event => setOther(event.target.value)} /></label><button type="button" disabled={!otherValid} onClick={() => { onChange([...new Set([...value, `other:${other.trim()}`])]); setOther(""); }}>Add equipment</button></div>{other.trim() && !otherValid && <p role="alert">Use up to 40 letters, numbers, spaces or . , / ( ) + -.</p>}
  </section>;
}
