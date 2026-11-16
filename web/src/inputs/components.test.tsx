import { useState } from "react";
import { dateValue, setDate } from "./testDates";
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
    const labels = { grower: "You entered", verified_source: "Published source", dataset_estimate: "Area estimate", ai_suggested: "AI suggestion, not verified", source_checked: "AI-found, quote checked", assumed: "Guess", calculation: "Calculated", nasa_measured: "NASA measured", nasa_modeled: "NASA model" };
    for (const origin of originSchema.options) expect(screen.getByText(labels[origin])).toHaveAttribute("data-origin", origin);
    for (const origin of ["ai_suggested", "source_checked"]) expect(container.querySelector(`[data-origin="${origin}"]`)).not.toHaveClass("acre-input-origin-verified_source");
  });
  it("searches as you type and emits a selected catalog crop with its facts", async () => {
    const onChange = vi.fn(); const api = { ...exampleApi, search: vi.fn(exampleApi.search) };
    function Picker() { const [crop, setCrop] = useState<Crop | null>(null); return <CropPicker regionKey="US-NC" value={crop} onChange={value => { setCrop(value); onChange(value); }} api={api} />; }
    render(<Picker />);
    fireEvent.change(screen.getByRole("combobox", { name: "Crop" }), { target: { value: "soy" } });
    fireEvent.click(await screen.findByRole("option", { name: /^Soybean/ }));
    expect(api.search).toHaveBeenLastCalledWith("soy", "US-NC", expect.any(AbortSignal));
    expect(onChange).toHaveBeenCalledWith(exampleCrops[1]);
    expect(screen.getByText("Family: Fabaceae")).toBeInTheDocument();
    expect(screen.getByText("Typical dates for your area: found")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Published source")).toBeInTheDocument();
  });
  it("polls AI research with progress, shows sources, and lets the grower select the result", async () => {
    vi.useFakeTimers();
    const api = { ...exampleApi, research: vi.fn(exampleApi.research), researchJob: vi.fn(exampleApi.researchJob) };
    function Picker() { const [crop, setCrop] = useState<Crop | null>(null); return <CropPicker regionKey="US-NC" value={crop} onChange={setCrop} api={api} />; }
    render(<Picker />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "okra" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(screen.getByRole("option", { name: /Look up “okra”/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("status")).toHaveTextContent("Checking published references");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(api.researchJob).toHaveBeenCalledWith("example-okra", expect.any(AbortSignal));
    expect(screen.getByText("AI-suggested · review before use")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Example AI citation/ })).toBeInTheDocument();
    expect(screen.getByText("AI suggestion, not verified")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Okra" }));
    expect(screen.getByRole("button", { name: "Change crop" })).toBeInTheDocument();
    expect(api.research).toHaveBeenCalledWith("okra", "US-NC", expect.any(AbortSignal));
  });
  it("ignores a stale search after the query changes", async () => {
    let finish: (value: Awaited<ReturnType<typeof exampleApi.search>>) => void = () => {};
    const api = { ...exampleApi, search: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ meta: {}, results: [exampleCrops[1]], can_research: true }) };
    render(<CropPicker regionKey="US-NC" value={null} onChange={vi.fn()} api={api} />);
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "soy" } });
    await screen.findByRole("option", { name: /^Soybean/ });
    await act(async () => { finish({ meta: {}, results: [exampleCrops[0]!], can_research: true }); });
    expect(screen.queryByRole("option", { name: /^Field corn/ })).not.toBeInTheDocument();
  });
  it("preserves blank dates, fills typical dates with provenance, and marks farmer edits grower", async () => {
    const api = { ...exampleApi, autofill: vi.fn(exampleApi.autofill) };
    render(<ControlledPlan api={api} initial={{ ...examplePlan, plan: { ...examplePlan.plan, next_plant: null }, dates: examplePlan.dates.filter(date => date.field !== "next_plant") }} />);
    expect(dateValue("Next planting")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Fill typical dates" }));
    await waitFor(() => expect(dateValue("Next planting")).toBe("05-05"));
    expect(api.autofill).toHaveBeenCalledWith({ location: exampleLocation, crops: [{ role: "previous", crop_id: "field_corn" }, { role: "cover", crop_id: "cereal_rye" }, { role: "next", crop_id: "soybean" }] }, expect.any(AbortSignal));
    const group = () => screen.getByRole("group", { name: "Next planting" });
    expect(within(group()).getByText("Area estimate")).toBeInTheDocument();
    setDate("Next planting", "05-12");
    expect(within(group()).getByText("You entered")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fill typical dates" }));
    await waitFor(() => expect(api.autofill).toHaveBeenCalledTimes(2));
    expect(dateValue("Next planting")).toBe("05-12");
    // A day that the month does not have cannot be chosen: the list stops at the month's last day.
    fireEvent.change(within(group()).getByRole("combobox", { name: "Next planting: month" }), { target: { value: "02" } });
    expect(within(group()).getByRole("combobox", { name: "Next planting: day" }).querySelectorAll("option")).toHaveLength(30);
    expect(within(group()).getByText("12 February, every year.")).toBeInTheDocument();
  });
  it("matches regional references through backend crop aliases", async () => {
    const defaults = { ...exampleEconomics, crops: [{ ...exampleEconomics.crops[0]!, crop_id: "maize", aliases: ["field_corn"] }] };
    const api = { ...exampleApi, estimate: vi.fn().mockResolvedValue(defaults) };
    render(<EconomicsEditor location={exampleLocation} crops={["field_corn"]} area={{ value: 16.2, unit: "ha" }} value={createEconomicsValue()} onChange={vi.fn()} api={api} />);
    const crop = screen.getByRole("region", { name: "field corn economics" });
    await waitFor(() => expect(within(crop).getByRole("spinbutton", { name: "Price · typical value" })).toHaveValue(11.2));
    expect(within(crop).getByRole("spinbutton", { name: "Cost · seed value" })).toHaveValue(62);
    expect(within(crop).getAllByText("Published source").length).toBeGreaterThan(0);
  });
  it("preserves grower edits made while autofill is in flight", async () => {
    let finish!: (response: Awaited<ReturnType<typeof exampleApi.autofill>>) => void;
    const api = { ...exampleApi, autofill: vi.fn(() => new Promise<Awaited<ReturnType<typeof exampleApi.autofill>>>(resolve => { finish = resolve; })) };
    render(<ControlledPlan api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Fill typical dates" }));
    setDate("Next planting", "05-20");
    await act(async () => { finish(await exampleApi.autofill({ location: exampleLocation, crops: [{ role: "next", crop_id: "soybean" }] })); });
    expect(dateValue("Next planting")).toBe("05-20");
  });
  it("supports winter grain and clears dates when the winter use changes", () => {
    render(<ControlledPlan />);
    fireEvent.change(screen.getByRole("combobox", { name: "Winter use" }), { target: { value: "winter_grain" } });
    expect(dateValue("Winter grain planting")).toBe("");
    expect(dateValue("Winter grain harvest")).toBe("");
    expect(screen.queryByRole("group", { name: "Cover seeding" })).not.toBeInTheDocument();
  });
  it("renders defaults with sources, leaves gaps blank, and resets a grower override", async () => {
    render(<ControlledEconomics />);
    const typical = await screen.findByRole("spinbutton", { name: "Price · typical value" });
    await waitFor(() => expect(typical).toHaveValue(11.2));
    expect(screen.getByRole("spinbutton", { name: "Cost · fertilizer value" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Cost · fertilizer value" })).toHaveAttribute("placeholder", "Enter yours");
    expect(screen.getAllByRole("link", { name: /Example price reference/ })).toHaveLength(3);
    fireEvent.change(typical, { target: { value: "12.5" } });
    expect(typical).toHaveValue(12.5);
    expect(within(typical.closest("td")!).getByText("You entered")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset Price · typical" })); expect(typical).toHaveValue(11.2);
    fireEvent.change(typical, { target: { value: "0" } }); expect(typical).toHaveValue(0);
    fireEvent.change(typical, { target: { value: "" } }); expect(typical).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Dry spring yield loss percent" })).toHaveValue(null);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Dry spring yield loss percent" }), { target: { value: "15" } });
    expect(screen.getByRole("spinbutton", { name: "Dry spring yield loss percent" })).toHaveValue(15);
    // The "your estimate" label appears only beside a loss the grower has given.
    expect(screen.getAllByText("Guess")).toHaveLength(1);
    expect(screen.getByText(/These are your own estimates/)).toBeInTheDocument();
    // The choices set the same number as typing it; "I don't know" clears it.
    fireEvent.click(within(screen.getByRole("group", { name: /heavy rain/ })).getByRole("button", { name: "About half" }));
    expect(screen.getByRole("spinbutton", { name: "Heavy rain yield loss percent" })).toHaveValue(50);
    fireEvent.click(within(screen.getByRole("group", { name: /heavy rain/ })).getByRole("button", { name: "I don't know" }));
    expect(screen.getByRole("spinbutton", { name: "Heavy rain yield loss percent" })).toHaveValue(null);
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
    // The one price the grower entered is used for bad and good years too, until they set those apart.
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Price · low value" })).toHaveValue(13));
    expect(screen.getByRole("spinbutton", { name: "Price · typical value" })).toHaveValue(13);
    expect(screen.getByRole("spinbutton", { name: "Yield value" })).toHaveValue(48);
  });
  it("leaves unavailable references editable without replacing them with zero", async () => {
    const api = { ...exampleApi, estimate: async () => ({ ...exampleEconomics, currency: null, crops: [{ crop_id: "soybean", aliases: [], price: null, yield: null, costs: { items: [], total_per_area: null }, status: "unavailable" as const, reason_text: "No regional references." }] }) };
    render(<ControlledEconomics api={api} />);
    await screen.findByText("No regional references.");
    expect(screen.getByRole("spinbutton", { name: "Price · typical value" })).toHaveValue(null);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Yield value" }), { target: { value: "0" } });
    expect(screen.getByRole("spinbutton", { name: "Yield value" })).toHaveValue(0);
  });
  it("adds volumetric readings and preserves measurement depth", () => {
    const onChange = vi.fn();
    render(<ReadingsLog value={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-04-02" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Reading type" }), { target: { value: "soil_moisture_vwc" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Volumetric soil moisture (m³/m³)" }), { target: { value: "0.3" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Depth (cm, optional)" }), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reading" }));
    expect(onChange).toHaveBeenCalledWith([{ date: "2026-04-02", kind: "soil_moisture_vwc", value: 0.3, depth_cm: 10, origin: "grower" }]);
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
    // Rain is the first choice, already picked: a reading is the amount and one press.
    expect(screen.getByRole("button", { name: "Rain I measured" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rainfall (mm)" }), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reading" }));
    expect(screen.getByRole("img")).toHaveAccessibleName(/Rainfall readings/);
    const list = screen.getByRole("list", { name: "Recorded readings" }); expect(within(list).getAllByText("Rainfall: 0 mm")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "A note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Standing water near the gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reading" })); // The grower's own words sit in their own element, marked so they are never sent for translation.
    expect(screen.getByText("Standing water near the gate")).toHaveAttribute("translate", "no");
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
    expect(dateValue("Previous harvest")).toBe("");
    expect(dateValue("Next planting")).toBe("");
    expect(screen.getByRole("button", { name: "Fill typical dates" })).toBeDisabled();
  });
  it("shows failed research and does not offer a crop to select", async () => {
    const api = { ...exampleApi, research: async () => ({ ...exampleResearchReady, crop: undefined, job_status: "failed" as const, reason_text: "No usable sources found." }) };
    render(<CropPicker regionKey="US-NC" value={null} onChange={vi.fn()} api={api} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "okra" } });
    fireEvent.click(await screen.findByRole("option", { name: /Look up “okra”/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No usable sources found.");
    expect(screen.queryByRole("button", { name: "Use Okra" })).not.toBeInTheDocument();
  });
  it("lists library crops on click, offers research only for a crop that is not listed, and lets a picked crop be changed", async () => {
    const onChange = vi.fn();
    function Picker() { const [crop, setCrop] = useState<Crop | null>(null); return <CropPicker regionKey="US-NC" value={crop} onChange={value => { setCrop(value); onChange(value); }} api={exampleApi} />; }
    render(<Picker />);
    fireEvent.focus(screen.getByRole("combobox", { name: "Crop" }));
    expect(await screen.findByRole("option", { name: /^Field corn/ })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Soybean" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.queryByRole("option", { name: /Look up/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(exampleCrops[1]);
    fireEvent.click(screen.getByRole("button", { name: "Change crop" }));
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Replace Soybean: type or pick a crop");
    fireEvent.click(screen.getByRole("button", { name: "Keep Soybean" }));
    expect(screen.getByText("Soybean")).toBeInTheDocument();
  });
  it("shows only crop choices, or only dates that fill themselves in once", async () => {
    const api = { ...exampleApi, autofill: vi.fn(exampleApi.autofill) };
    const { unmount } = render(<PlanEditor show="crops" location={exampleLocation} regionKey="US-NC" value={examplePlan} onChange={vi.fn()} api={api} />);
    expect(screen.queryByRole("textbox", { name: /harvest|planting/i })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Winter use" })).toBeInTheDocument();
    unmount();
    const blank: PlanEditorValue = { ...examplePlan, plan: { ...examplePlan.plan, next_plant: null }, dates: examplePlan.dates.filter(date => date.field !== "next_plant") };
    function Dates() { const [value, setValue] = useState(blank); return <PlanEditor show="dates" location={exampleLocation} regionKey="US-NC" value={value} onChange={setValue} api={api} />; }
    render(<Dates />);
    expect(screen.queryByRole("region", { name: "Previous crop" })).not.toBeInTheDocument();
    await waitFor(() => expect(dateValue("Planting date")).toBe("05-05"));
    expect(api.autofill).toHaveBeenCalledTimes(1);
    expect(dateValue("Harvest date")).toBe("10-10");
  });
  it("splits prices from weather-loss estimates and labels the filled-in values", async () => {
    const { unmount } = render(<EconomicsEditor show="prices" location={exampleLocation} crops={["soybean"]} area={{ value: 16.2, unit: "ha" }} value={createEconomicsValue()} onChange={vi.fn()} api={exampleApi} />);
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Price · typical value" })).toHaveValue(11.2));
    expect(screen.getByText(/Where a published number exists for your area/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /weather losses/ })).not.toBeInTheDocument();
    unmount();
    const estimate = vi.fn(exampleApi.estimate);
    render(<EconomicsEditor show="losses" location={exampleLocation} crops={["soybean"]} area={{ value: 16.2, unit: "ha" }} value={createEconomicsValue()} onChange={vi.fn()} api={{ ...exampleApi, estimate }} />);
    expect(screen.getByRole("group", { name: /weather losses/ })).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Price · typical value" })).not.toBeInTheDocument();
    expect(estimate).not.toHaveBeenCalled();
  });
});
