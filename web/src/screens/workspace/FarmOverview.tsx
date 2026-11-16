import type { FarmAnalysis } from "../../api/model";
import { formatArea } from "../../farm/geometry";
import type { Farm } from "../../farm/types";
import { STATUS_TEXT } from "../../map/LocationCard";

/*
  The farm overview (card D2): one row per field. Area is the only total, and it is the
  backend's (`totals`); before an analysis the table shows each field's display area and no
  total. No metric is ever summed across fields.
*/
export function FarmOverview({ farm, analysis, onOpen }: { farm: Farm; analysis: FarmAnalysis | null; onOpen: (fieldId: string) => void }) {
  const byId = new Map(analysis?.fields.map((f) => [f.fieldId, f]));
  const crops = (id: string) => {
    const p = farm.fields.find((f) => f.field_id === id)?.plan;
    if (!p) return "No plan yet";
    const mid = p.winter.kind === "none" ? "nothing" : p.winter.crop_id.replace(/_/g, " ");
    return `${p.previous_crop_id.replace(/_/g, " ")} → ${mid} → ${p.next_crop_id.replace(/_/g, " ")}`;
  };
  return (
    <section className="db-card fo" aria-label="Farm overview">
      <div className="db-card-head">
        <h2>{farm.name}</h2>
      </div>
      <table className="fo-table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Area</th>
            <th scope="col">Plan</th>
            <th scope="col">Analysis</th>
            <th scope="col">Weather cell</th>
          </tr>
        </thead>
        <tbody>
          {farm.fields.map((f) => {
            const a = byId.get(f.field_id);
            const area = a?.areaHa != null ? `${a.areaHa} ha` : `${formatArea(f.geometry).ha} ha (map)`;
            const state = !f.plan ? "Needs a plan" : !a ? "Not analysed yet" : a.jobStatus === "pending" ? "Fetching weather" : (STATUS_TEXT[a.status] ?? a.status);
            return (
              <tr key={f.field_id}>
                <th scope="row">
                  <button type="button" className="fo-open" onClick={() => onOpen(f.field_id)}>
                    {f.name}
                  </button>
                </th>
                <td>{area}</td>
                <td>{crops(f.field_id)}</td>
                <td>{state}</td>
                <td>{a?.cellId ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
        {analysis?.totals.areaHa != null ? (
          <tfoot>
            <tr>
              <th scope="row">Total area</th>
              <td>
                {analysis.totals.areaHa} ha{analysis.totals.areaAc != null ? ` · ${analysis.totals.areaAc} ac` : ""}
              </td>
              <td colSpan={3} className="fo-note">
                Only area is totalled. Each field's results stay its own.
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
      {analysis?.weatherCells
        .filter((c) => c.fieldIds.length > 1)
        .map((c) => (
          <p key={c.cellId} className="fo-cell">
            {c.fieldIds.map((id) => farm.fields.find((f) => f.field_id === id)?.name ?? id).join(", ")}: {c.note}
          </p>
        ))}
    </section>
  );
}
