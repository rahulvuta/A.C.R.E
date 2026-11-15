import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AreaSummary, CropPicker, EconomicsEditor, EquipmentEditor, PlanEditor, ReadingsLog, createEconomicsValue, createPlanEditorValue, type Crop, type EconomicsValue, type PlanEditorValue, type Reading } from "./index";
import { createExampleInputsApi, exampleCrops, exampleEconomics, exampleLocation, examplePlan, exampleReadings, exampleResearchReady } from "./examples";
import { OriginLabel } from "./shared";
import { originSchema } from "./schema";

afterEach(() => { vi.useRealTimers(); });
const exampleApi = createExampleInputsApi();
function ControlledPlan({ api = exampleApi, initial = examplePlan }: { api?: typeof exampleApi; initial?: PlanEditorValue }) { const [value, setValue] = useState(initial); return <PlanEditor location={exampleLocation} regionKey="US-NC" value={value} onChange={setValue} api={api} />; }
function ControlledEconomics({ api = exampleApi, initial = createEconomicsValue() }: { api?: typeof exampleApi; initial?: EconomicsValue }) { const [value, setValue] = useState(initial); return <EconomicsEditor location={exampleLocation} crops={["soybean"]} area={{ value: 16.2, unit: "ha" }} value={value} onChange={setValue} api={api} />; }
describe("farmer inputs", () => {
  it("renders the supplied area in both units, distinguishes missing from zero, and shows provenance", () => {
    const { rerender, container } = render(<AreaSummary areaHa={16.2} />);
    expect(screen.getByText("40.03")).toBeInTheDocument();
    expect(screen.getByText("16.2")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-origin="calculation"]')).toHaveLength(2);
    rerender(<AreaSummary areaHa={null} />);
    expect(screen.getAllByText("Not available")).toHaveLength(2);
    rerender(<AreaSummary areaHa={0} />);
    expect(screen.getAllByText("0")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/score/i);
  });
  it("shows exact origin labels and gives AI origins different classes from verified sources", () => {
    const { container } = render(<>{originSchema.options.map(origin => <OriginLabel key={origin} origin={origin} />)}</>);
    for (const origin of originSchema.options) expect(screen.getByText(origin)).toHaveAttribute("data-origin", origin);
    for (const origin of ["ai_suggested", "source_checked"]) expect(container.querySelector(`[data-origin="${origin}"]`)).not.toHaveClass("acre-input-origin-verified_source");
  });
  it("searches as you type and emits a selected catalog crop with its facts", async () => {
    const onChange = vi.fn(); const api = { ...exampleApi, search: vi.fn(exampleApi.search) };
    render(<CropPicker regionKey="US-NC" value={null} onChange={onChange} api={api} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Crop" }), { target: { value: "soy" } });
    fireEvent.click(await screen.findByRole("button", { name: "Soybean" }));
    expect(api.search).toHaveBeenLastCalledWith("soy", "US-NC", expect.any(AbortSignal));
    expect(onChange).toHaveBeenCalledWith(exampleCrops[1]);
    expect(screen.getByText("Family: Fabaceae")).toBeInTheDocument();
    expect(screen.getByText("Calendar: Available")).toBeInTheDocument();
    expect(screen.getByText("verified_source")).toBeInTheDocument();
  });
  it("polls AI research with progress, shows sources, and lets the grower select the result", async () => {
    vi.useFakeTimers();
    const api = { ...exampleApi, research: vi.fn(exampleApi.research), researchJob: vi.fn(exampleApi.researchJob) };
    function Picker() { const [crop, setCrop] = useState<Crop | null>(null); return <CropPicker regionKey="US-NC" value={crop} onChange={setCrop} api={api} />; }
    render(<Picker />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "okra" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(screen.getByRole("button", { name: "Research 'okra' with AI" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("status")).toHaveTextContent("Checking published references");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(api.researchJob).toHaveBeenCalledWith("example-okra", expect.any(AbortSignal));
    expect(screen.getByText("AI-suggested · review before use")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Example AI citation/ })).toBeInTheDocument();
    expect(screen.getByText("ai_suggested")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Okra" }));
    expect(screen.getByRole("button", { name: "Clear crop" })).toBeInTheDocument();
    expect(api.research).toHaveBeenCalledWith("okra", "US-NC", expect.any(AbortSignal));
  });
  it("ignores a stale search after the query changes", async () => {
    let finish: (value: Awaited<ReturnType<typeof exampleApi.search>>) => void = () => {};
    const api = { ...exampleApi, search: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ meta: {}, results: [exampleCrops[1]], can_research: true }) };
    render(<CropPicker regionKey="US-NC" value={null} onChange={vi.fn()} api={api} />);
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "soy" } });
    await screen.findByRole("button", { name: "Soybean" });
    await act(async () => { finish({ meta: {}, results: [exampleCrops[0]!], can_research: true }); });
    expect(screen.queryByRole("button", { name: "Field corn" })).not.toBeInTheDocument();
  });
  it("preserves blank dates, fills typical dates with provenance, and marks farmer edits grower", async () => {
    const api = { ...exampleApi, autofill: vi.fn(exampleApi.autofill) };
    render(<ControlledPlan api={api} initial={{ ...examplePlan, plan: { ...examplePlan.plan, next_plant: null }, dates: examplePlan.dates.filter(date => date.field !== "next_plant") }} />);
    const date = screen.getByRole("textbox", { name: "Next planting" });
    expect(date).toHaveValue(""); expect(date).toHaveAttribute("placeholder", "Not available");
    fireEvent.click(screen.getByRole("button", { name: "Fill typical dates" }));
    await waitFor(() => expect(date).toHaveValue("05-05"));
    expect(api.autofill).toHaveBeenCalledWith({ location: exampleLocation, crops: [{ role: "previous", crop_id: "field_corn" }, { role: "cover", crop_id: "cereal_rye" }, { role: "next", crop_id: "soybean" }] }, expect.any(AbortSignal));
    expect(within(date.parentElement!.parentElement!).getByText("dataset_estimate")).toBeInTheDocument();
    fireEvent.change(date, { target: { value: "05-12" } });
    expect(within(date.parentElement!.parentElement!).getByText("grower")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fill typical dates" }));
    await waitFor(() => expect(api.autofill).toHaveBeenCalledTimes(2));
    expect(date).toHaveValue("05-12");
    fireEvent.change(date, { target: { value: "02-31" } }); expect(date).toHaveAttribute("aria-invalid", "true");
  });
  it("preserves grower edits made while autofill is in flight", async () => {
    let finish!: (response: Awaited<ReturnType<typeof exampleApi.autofill>>) => void;
    const api = { ...exampleApi, autofill: vi.fn(() => new Promise<Awaited<ReturnType<typeof exampleApi.autofill>>>(resolve => { finish = resolve; })) };
    render(<ControlledPlan api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Fill typical dates" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Next planting" }), { target: { value: "05-20" } });
    await act(async () => { finish(await exampleApi.autofill({ location: exampleLocation, crops: [{ role: "next", crop_id: "soybean" }] })); });
    expect(screen.getByRole("textbox", { name: "Next planting" })).toHaveValue("05-20");
  });
  it("supports winter grain and clears dates when the winter use changes", () => {
    render(<ControlledPlan />);
    fireEvent.change(screen.getByRole("combobox", { name: "Winter use" }), { target: { value: "winter_grain" } });
    expect(screen.getByRole("textbox", { name: "Winter grain planting" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Winter grain harvest" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Cover seeding" })).not.toBeInTheDocument();
  });
  it("renders defaults with sources, leaves gaps blank, and resets a grower override", async () => {
    render(<ControlledEconomics />);
    const typical = await screen.findByRole("spinbutton", { name: "Price · typical value" });
    await waitFor(() => expect(typical).toHaveValue(11.2));
    expect(screen.getByRole("spinbutton", { name: "Cost · fertilizer value" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Cost · fertilizer value" })).toHaveAttribute("placeholder", "Not available");
    expect(screen.getAllByRole("link", { name: /Example price reference/ })).toHaveLength(3);
    fireEvent.change(typical, { target: { value: "12.5" } });
    expect(typical).toHaveValue(12.5);
    expect(within(typical.closest("td")!).getByText("grower")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset Price · typical" })); expect(typical).toHaveValue(11.2);
    fireEvent.change(typical, { target: { value: "0" } }); expect(typical).toHaveValue(0);
    fireEvent.change(typical, { target: { value: "" } }); expect(typical).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Dry spring yield loss percent" })).toHaveValue(null);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Dry spring yield loss percent" }), { target: { value: "15" } });
    expect(screen.getByRole("spinbutton", { name: "Dry spring yield loss percent" })).toHaveValue(15);
    expect(screen.getAllByText("assumed")).toHaveLength(2);
    expect(screen.getByText(/These percentages are your estimates/)).toBeInTheDocument();
    expect(screen.queryByText(/score/i)).not.toBeInTheDocument();
  });
  it("keeps overrides through a defaults refresh and lets the grower enter inputs when the API fails", async () => {
    const initial: EconomicsValue = { ...createEconomicsValue(), overrides: { soybean: { yield: { value: 48, unit: "bu/acre", origin: "grower" } } } };
    const api = { ...exampleApi, estimate: vi.fn().mockRejectedValueOnce(new Error("Service offline")).mockResolvedValueOnce(exampleEconomics) };
    render(<ControlledEconomics api={api} initial={initial} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("spinbutton", { name: "Yield value" })).toHaveValue(48);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Price · typical value" }), { target: { value: "13" } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.estimate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Price · low value" })).toHaveValue(9.5));
    expect(screen.getByRole("spinbutton", { name: "Price · typical value" })).toHaveValue(13);
    expect(screen.getByRole("spinbutton", { name: "Yield value" })).toHaveValue(48);
  });
  it("uses the equipment vocabulary and supports named other equipment", async () => {
    function Equipment() { const [value, setValue] = useState<string[]>([]); return <EquipmentEditor value={value} onChange={setValue} api={exampleApi} />; }
    render(<Equipment />);
    const planter = await screen.findByRole("checkbox", { name: "Planter" }); fireEvent.click(planter); expect(planter).toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "Other equipment" }), { target: { value: "Hand seeder" } });
    fireEvent.click(screen.getByRole("button", { name: "Add equipment" })); expect(screen.getByText("Hand seeder")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Hand seeder" })); expect(screen.queryByText("Hand seeder")).not.toBeInTheDocument();
  });
  it("adds dated readings including zero and notes, charts one unit at a time, and removes readings", () => {
    function Log() { const [value, setValue] = useState<Reading[]>(exampleReadings); return <ReadingsLog value={value} onChange={setValue} />; }
    render(<Log />);
    expect(screen.getByRole("img")).toHaveAccessibleName(/Soil moisture readings/);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-04-15" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Reading type" }), { target: { value: "rainfall_mm" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rainfall (mm)" }), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reading" }));
    expect(screen.getByRole("img")).toHaveAccessibleName(/Rainfall readings/);
    const list = screen.getByRole("list", { name: "Recorded readings" }); expect(within(list).getAllByText("Rainfall: 0 mm")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Reading type" }), { target: { value: "note" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Standing water near the gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reading" })); expect(screen.getByText("Field note: Standing water near the gate")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove rainfall on 2026-04-15" })); expect(within(list).getAllByText("Rainfall: 0 mm")).toHaveLength(1);
  });
  it("rejects a blank numeric reading instead of recording zero and renders supplied null as unavailable", () => {
    const onChange = vi.fn();
    render(<ReadingsLog value={[{ date: "2026-04-02", kind: "rainfall_mm", value: null, origin: "grower" }]} onChange={onChange} />);
    expect(screen.getByText("Rainfall: Not available")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-04-02" } }); fireEvent.click(screen.getByRole("button", { name: "Add reading" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a reading"); expect(onChange).not.toHaveBeenCalled();
  });
  it("renders a completely blank plan without inventing dates", () => {
    render(<ControlledPlan initial={createPlanEditorValue()} />);
    expect(screen.getByRole("textbox", { name: "Previous harvest" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Next planting" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Fill typical dates" })).toBeDisabled();
  });
  it("shows failed research and does not offer a crop to select", async () => {
    const api = { ...exampleApi, research: async () => ({ ...exampleResearchReady, crop: undefined, job_status: "failed" as const, reason_text: "No usable sources found." }) };
    render(<CropPicker regionKey="US-NC" value={null} onChange={vi.fn()} api={api} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "okra" } });
    fireEvent.click(await screen.findByRole("button", { name: "Research 'okra' with AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No usable sources found.");
    expect(screen.queryByRole("button", { name: "Use Okra" })).not.toBeInTheDocument();
  });
});
