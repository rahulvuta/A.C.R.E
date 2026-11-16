import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adaptFarmAnalysis, BackendFarmAnalysis } from "../../api/adapt";
import { FIXTURES, POLYGONS } from "../../api/fixtures";
import type { Farm, FieldGeometry } from "../../farm/types";
import { getDraft, resetDraftsForTests, setDraft } from "../../state/drafts";
import { FarmOverview } from "./FarmOverview";
import { FieldResults, ResolutionNotices } from "./FieldResults";
import { emptyPlan } from "./FieldPlanEditor";

const analysis = adaptFarmAnalysis(BackendFarmAnalysis.parse(FIXTURES.farmTwo));
const farm: Farm = {
  schema: "acre.farm.v1",
  farm_id: "f",
  name: "Synthetic farm",
  anchor: { latitude: 0, longitude: 0 },
  created_at: "",
  updated_at: "",
  fields: analysis.fields.map((f) => ({ field_id: f.fieldId, name: f.name, geometry: POLYGONS.pergamino_square.geometry as FieldGeometry, plan: null })),
};

describe("field planning (D2/D3)", () => {
  it("overview totals area only, never a metric", () => {
    render(<FarmOverview farm={farm} analysis={analysis} onOpen={() => {}} />);
    const foot = screen.getByText("Total area").closest("tr")!;
    expect(foot.textContent).toMatch(/ha/);
    expect(foot.textContent).not.toMatch(/mm|days/);
  });

  it("shows the shared-cell notice for two fields in one cell", () => {
    render(<ResolutionNotices analysis={analysis} field={analysis.fields[0]!} profile={null} caps={null} />);
    expect(screen.getByText(/share one NASA weather series/)).toBeTruthy();
  });

  it("uses the backend's off-season label in the Southern Hemisphere", () => {
    const f = analysis.fields.find((x) => x.result?.hemisphere === "south");
    if (!f) return;
    render(<FieldResults field={f} />);
    expect(screen.getAllByText(/Off-season/).length).toBeGreaterThan(0);
  });

  it("keeps each field's draft when switching", () => {
    resetDraftsForTests();
    const [a, b] = farm.fields;
    setDraft(a!.field_id, { ...emptyPlan(a!), next_plant: "11-15" });
    setDraft(b!.field_id, { ...emptyPlan(b!), next_plant: "10-20" });
    expect(getDraft(a!.field_id)?.next_plant).toBe("11-15");
    expect(getDraft(b!.field_id)?.next_plant).toBe("10-20");
  });
});
