import { useState } from "react";
import { dateValue, setDate } from "./testDates";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EconomicsEditor, PlanEditor, createEconomicsValue, createPlanEditorValue, resetCalendarLookupsForTests, resetEconomicsLookupsForTests, type EconomicsValue, type PlanEditorValue } from "./index";
import { createExampleInputsApi, exampleCrops, exampleEconomics, exampleLocation } from "./examples";
import { createInputsApi, type InputsApi } from "./api";
import { economicsResponseSchema, type CropEconomics } from "./schema";

const base = createExampleInputsApi();
const meta = { example: true };
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
beforeEach(() => { vi.useFakeTimers(); resetEconomicsLookupsForTests(); resetCalendarLookupsForTests(); });
afterEach(() => { vi.useRealTimers(); });

/* ---------- prices, yields and costs ---------- */
const checkedSource = { title: "Synthetic extension page (test)", url: "https://example.invalid/page", evidence_quote: "Synthetic quote." };
const blank = (cropId: string): CropEconomics => ({ crop_id: cropId, aliases: [], price: null, yield: null, costs: { items: [], total_per_area: null }, status: "unavailable", reason_text: null, economics_research: { researched_at: null, status: null }, suggestions: [] });
const found = (cropId: string): CropEconomics => ({ ...blank(cropId), status: "partial", economics_research: { researched_at: "2026-01-01T00:00:00Z", status: "partial" },
  price: { low: 5, typical: 6, high: 7, unit: "USD/bu", origin: "source_checked", source: checkedSource }, yield: { value: 30, unit: "bu/acre", origin: "source_checked", source: checkedSource } });
function econApi({ available = true, finish = true, jobStatus = "ready", crops = {} as Record<string, CropEconomics>, research }: { available?: boolean; finish?: boolean; jobStatus?: "ready" | "failed"; crops?: Record<string, CropEconomics>; research?: null } = {}) {
  const done = new Set<string>();
  const estimate = vi.fn(async (request: { crops: string[] }) => economicsResponseSchema.parse({
    meta, currency: "USD", area_unit: "acre", gaps: [], ...(research === null ? {} : { research: { available, region_key: "US-NC" } }),
    crops: request.crops.map(id => done.has(id) && finish ? found(id) : crops[id] ?? blank(id)),
  }));
  const economicsResearch = vi.fn(async (cropId: string, _region?: string, _signal?: AbortSignal, _refresh?: boolean) => ({ meta, job_id: `job-${cropId}`, job_status: "pending" as "pending" | "ready" | "failed", status: "pending", crop_id: cropId, region_key: "US-NC" }));
  const economicsResearchJob = vi.fn(async (jobId: string, _signal?: AbortSignal) => {
    const cropId = jobId.replace("job-", ""); done.add(cropId);
    return { meta, job_id: jobId, job_status: jobStatus as "pending" | "ready" | "failed", status: jobStatus === "ready" ? "complete" : "failed", crop_id: cropId, region_key: "US-NC", reason_text: jobStatus === "failed" ? "No page could be read." : null };
  });
  return { ...base, estimate, economicsResearch, economicsResearchJob };
}
function Econ({ api, crops = ["soybean"], initial = createEconomicsValue(), onChange }: { api: InputsApi; crops?: string[]; initial?: EconomicsValue; onChange?: (value: EconomicsValue) => void }) {
  const [value, setValue] = useState(initial);
  return <EconomicsEditor show="prices" location={exampleLocation} crops={crops} area={{ value: 16.2, unit: "ha" }} value={value} onChange={next => { setValue(next); onChange?.(next); }} api={api} />;
}
const typical = () => screen.getByRole("spinbutton", { name: "Price · typical value" });

describe("automatic price lookup", () => {
  it("looks up a crop with missing values once, sends only the crop and region, and shows what was found", async () => {
    const api = econApi();
    render(<Econ api={api} />);
    await tick(10);
    expect(api.economicsResearch).toHaveBeenCalledTimes(1);
    expect(api.economicsResearch).toHaveBeenCalledWith("soybean", "US-NC", expect.any(AbortSignal));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Looking up published prices, yields and costs for soybean… This usually takes under a minute.");
    expect(typical()).toHaveValue(null);
    expect(api.economicsResearchJob).not.toHaveBeenCalled();
    await tick(2000);
    expect(api.economicsResearchJob).toHaveBeenCalledWith("job-soybean", expect.any(AbortSignal));
    await tick(10);
    expect(api.estimate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(typical()).toHaveValue(6);
    expect(within(typical().closest("td")!.nextElementSibling as HTMLElement).getByText("AI-found, quote checked")).toBeInTheDocument();
    expect(screen.getByText("Found by AI research and checked against the cited page. Change any number that is different on your farm.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Synthetic extension page (test)" }).length).toBeGreaterThan(0);
    await tick(10_000);
    expect(api.economicsResearch).toHaveBeenCalledTimes(1);
  });
  it("does not look anything up when research is unavailable, absent, already done, or nothing is missing", async () => {
    const off = econApi({ available: false });
    const { unmount } = render(<Econ api={off} />); await tick(10); unmount();
    const absent = econApi({ research: null });
    const second = render(<Econ api={absent} />); await tick(10); second.unmount();
    const researched = econApi({ crops: { soybean: { ...blank("soybean"), economics_research: { researched_at: "2026-01-01T00:00:00Z", status: "empty" } } } });
    const third = render(<Econ api={researched} />); await tick(10); third.unmount();
    const complete = createExampleInputsApi(); const spy = vi.fn(complete.economicsResearch);
    render(<Econ api={{ ...econApi(), estimate: complete.estimate, economicsResearch: spy }} />); await tick(10);
    for (const api of [off, absent, researched]) expect(api.economicsResearch).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(typical()).toHaveValue(11.2);
  });
  it("shows the old text when research is unavailable", async () => {
    render(<Econ api={econApi({ available: false })} />); await tick(10);
    expect(screen.getByText("No published prices or costs for this crop in this area. Enter yours if you know them.")).toBeInTheDocument();
  });
  it("does not start a second lookup for the same crop and region when the editor is remounted", async () => {
    const api = econApi({ finish: false });
    const first = render(<Econ api={api} />);
    await tick(10); await tick(2100); await tick(10);
    expect(screen.getByText(/No published prices, yields and costs found for soybean in this area\. Enter yours if you know them, or leave them blank: the simulation then runs without money results for this crop\./)).toBeInTheDocument();
    first.unmount();
    render(<Econ api={api} />); await tick(5000);
    expect(api.economicsResearch).toHaveBeenCalledTimes(1);
  });
  it("keeps a value the grower typed while the lookup runs", async () => {
    const api = econApi();
    const onChange = vi.fn();
    render(<Econ api={api} onChange={onChange} />);
    await tick(10);
    fireEvent.change(typical(), { target: { value: "12" } });
    await tick(10); await tick(2100); await tick(10);
    expect(api.estimate).toHaveBeenCalledTimes(2);
    expect(typical()).toHaveValue(12);
    expect(within(typical().closest("td")!).getByText("You entered")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Yield value" })).toHaveValue(30);
    fireEvent.click(screen.getByRole("button", { name: "Reset Price · typical" }));
    expect(typical()).toHaveValue(6);
  });
  it("stops on request and does not restart by itself, but offers to look up again", async () => {
    const api = econApi();
    render(<Econ api={api} />);
    await tick(10);
    fireEvent.click(screen.getByRole("button", { name: "Stop looking up soybean" }));
    const signal = api.economicsResearch.mock.calls[0]![2] as AbortSignal;
    expect(signal.aborted).toBe(true);
    await tick(10_000);
    expect(screen.queryByText(/Looking up published prices/)).not.toBeInTheDocument();
    expect(api.economicsResearch).toHaveBeenCalledTimes(1);
    expect(api.economicsResearchJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Look up soybean again" }));
    await tick(10);
    expect(api.economicsResearch).toHaveBeenCalledTimes(2);
    expect(api.economicsResearch).toHaveBeenLastCalledWith("soybean", "US-NC", expect.any(AbortSignal), true);
  });
  it("shows why a lookup failed and starts a new one on Try again", async () => {
    const api = econApi({ jobStatus: "failed" });
    render(<Econ api={api} />);
    await tick(10); await tick(2100); await tick(10);
    expect(screen.getByText("No page could be read.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again to look up soybean" }));
    await tick(10);
    expect(api.economicsResearch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Looking up published prices");
  });
  it("looks up several crops one after the other, in order", async () => {
    const api = econApi();
    render(<Econ api={api} crops={["soybean", "barley"]} />);
    await tick(10);
    expect(api.economicsResearch).toHaveBeenCalledTimes(1);
    expect(api.economicsResearch).toHaveBeenLastCalledWith("soybean", "US-NC", expect.any(AbortSignal));
    expect(screen.getByText("Waiting to look up barley.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop looking up soybean" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop looking up barley" })).not.toBeInTheDocument();
    await tick(10); await tick(2100); await tick(10);
    expect(api.economicsResearch).toHaveBeenCalledTimes(2);
    expect(api.economicsResearch).toHaveBeenLastCalledWith("barley", "US-NC", expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Stop looking up barley" })).toBeInTheDocument();
    await tick(10); await tick(2100); await tick(10);
    expect(api.economicsResearch).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("AI-found, quote checked").length).toBeGreaterThan(0);
  });
  it("stops polling after 90 checks and offers another try", async () => {
    const api = econApi();
    api.economicsResearchJob.mockImplementation(async (jobId: string) => ({ meta, job_id: jobId, job_status: "pending" as "pending" | "ready" | "failed", status: "pending", crop_id: "soybean", region_key: "US-NC", reason_text: null }));
    render(<Econ api={api} />);
    await tick(10);
    await tick(2000 * 92);
    expect(api.economicsResearchJob).toHaveBeenCalledTimes(90);
    expect(screen.getByText(/taking longer than expected/)).toBeInTheDocument();
  });
});

describe("suggestions the grower can adopt", () => {
  const suggestions = [
    { field: "price" as const, value: 8.25, unit: "USD/bu", year: 2024, origin: "ai_suggested" as const, source: { title: "Unchecked page", url: "https://example.invalid/unchecked", evidence_quote: "Soybeans sold for 8.25." } },
    { field: "costs" as const, item: "seed", value: 55, unit: "USD/acre", origin: "ai_suggested" as const, source: { title: "Seed page", url: "https://example.invalid/seed" } },
    { field: "costs" as const, value: 300, unit: "USD/acre", origin: "ai_suggested" as const, source: null },
  ];
  const withSuggestions = () => econApi({ crops: { soybean: { ...blank("soybean"), economics_research: { researched_at: "2026-01-01T00:00:00Z", status: "partial" }, suggestions } } });
  it("lists them as unverified and writes an adopted price as the grower's own low, typical and high", async () => {
    const api = withSuggestions(); const onChange = vi.fn();
    render(<Econ api={api} onChange={onChange} />);
    await tick(10);
    expect(api.economicsResearch).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Found by AI, not verified" })).toBeInTheDocument();
    expect(screen.getByText("These were found by AI research but could not be checked against the cited page. Open the source before using one.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "soybean suggestions found by AI" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByRole("link", { name: "Unchecked page" })).toHaveAttribute("href", "https://example.invalid/unchecked");
    expect(within(list).getByText("Soybeans sold for 8.25.").tagName).toBe("Q");
    fireEvent.click(screen.getByRole("button", { name: "Use this value for soybean Price" }));
    for (const priceCase of ["low", "typical", "high"]) {
      const input = screen.getByRole("spinbutton", { name: `Price · ${priceCase} value` });
      expect(input).toHaveValue(8.25);
      expect(within(input.closest("td")!).getByText("You entered")).toBeInTheDocument();
    }
    const last = onChange.mock.calls.at(-1)![0] as EconomicsValue;
    expect(last.overrides.soybean!.price).toEqual({ low: { value: 8.25, unit: "USD/bu", origin: "grower" }, typical: { value: 8.25, unit: "USD/bu", origin: "grower" }, high: { value: 8.25, unit: "USD/bu", origin: "grower" } });
    const used = screen.getByRole("button", { name: "Using this value for soybean Price" });
    expect(used).toBeDisabled(); expect(used).toHaveTextContent("Using this value");
    fireEvent.click(screen.getByRole("button", { name: "Reset Price · typical" }));
    expect(screen.getByRole("button", { name: "Use this value for soybean Price" })).toBeInTheDocument();
  });
  it("adds a cost suggestion as that cost item, and a total cost as the total", async () => {
    const onChange = vi.fn();
    render(<Econ api={withSuggestions()} onChange={onChange} />);
    await tick(10);
    fireEvent.click(screen.getByRole("button", { name: "Use this value for soybean Cost · seed" }));
    expect(screen.getByRole("spinbutton", { name: "Cost · seed value" })).toHaveValue(55);
    expect((onChange.mock.calls.at(-1)![0] as EconomicsValue).overrides.soybean!.costs).toEqual({ seed: { value: 55, unit: "USD/acre", origin: "grower" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this value for soybean Cost · total" }));
    expect(screen.getByRole("spinbutton", { name: "Cost · total value" })).toHaveValue(300);
    expect((onChange.mock.calls.at(-1)![0] as EconomicsValue).overrides.soybean!.costs).toEqual({ total: { value: 300, unit: "USD/acre", origin: "grower" } });
  });
});

describe("example API", () => {
  it("fills the unavailable example crop after its example lookup finishes", async () => {
    const api = createExampleInputsApi();
    const before = await api.estimate({ location: exampleLocation, crops: ["cereal_rye"], area: null, equipment: [], overrides: {} });
    expect(before.research).toEqual({ available: true, region_key: "US-NC" });
    expect(before.crops[0]!.price?.typical).toBeNull();
    const job = await api.economicsResearch("cereal_rye", "US-NC");
    expect(job.job_status).toBe("pending");
    expect((await api.economicsResearchJob(job.job_id)).job_status).toBe("ready");
    const after = await api.estimate({ location: exampleLocation, crops: ["cereal_rye"], area: null, equipment: [], overrides: {} });
    expect(after.crops[0]!.price?.origin).toBe("source_checked");
    expect(after.crops[0]!.suggestions?.[0]?.origin).toBe("ai_suggested");
    expect(exampleEconomics.crops.length).toBe(3);
  });
});

/* ---------- planting and harvest dates ---------- */
const soy = exampleCrops[1]!, corn = exampleCrops[0]!;
const entry = (crop_id: string, role: "previous" | "cover" | "next", extra: { researched_at?: string | null; missing?: boolean } = {}) => ({ crop_id, role, researched_at: null, missing: true, ...extra });
function planApi({ available = true, entries, finish = true, jobStatus = "ready" }: { available?: boolean; entries: ReturnType<typeof entry>[]; finish?: boolean; jobStatus?: "ready" | "failed" }) {
  const done = new Set<string>();
  const autofill = vi.fn(async () => {
    const dates: { field: string; value: string; origin: string; source: { title: string } }[] = [];
    if (finish && done.has("soybean")) dates.push({ field: "next_plant", value: "05-10", origin: "ai_suggested", source: { title: "Synthetic AI-found page" } });
    if (finish && done.has("field_corn")) dates.push({ field: "prev_harvest", value: "10-02", origin: "source_checked", source: { title: "Synthetic checked page" } });
    return { ...(await base.autofill({ location: exampleLocation, crops: [{ role: "previous", crop_id: "field_corn" }, { role: "cover", crop_id: "cereal_rye" }, { role: "next", crop_id: "soybean" }] })), dates, gaps: ["No typical date for Soybean."], research: { available, region_key: "US-NC" },
      calendar_research: entries.map(item => done.has(item.crop_id) && finish ? { ...item, researched_at: "2026-01-01T00:00:00Z", missing: false } : item) } as Awaited<ReturnType<typeof base.autofill>>;
  });
  const calendarResearch = vi.fn(async (cropId: string, _region?: string, _signal?: AbortSignal, _refresh?: boolean) => ({ meta, job_id: `cal-${cropId}`, job_status: "pending" as "pending" | "ready" | "failed", status: "pending", crop_id: cropId, region_key: "US-NC" }));
  const calendarResearchJob = vi.fn(async (jobId: string, _signal?: AbortSignal) => { const cropId = jobId.replace("cal-", ""); done.add(cropId); return { meta, job_id: jobId, job_status: jobStatus as "pending" | "ready" | "failed", status: "x", crop_id: cropId, region_key: "US-NC", reason_text: jobStatus === "failed" ? "No guidance found." : null }; });
  return { ...base, autofill, calendarResearch, calendarResearchJob };
}
const blankPlan = (previous = false): PlanEditorValue => ({ ...createPlanEditorValue(), plan: { ...createPlanEditorValue().plan, next_crop_id: "soybean", previous_crop_id: previous ? "field_corn" : null }, cropDetails: [soy, corn] });
function Plan({ api, show = "dates", initial = blankPlan() }: { api: InputsApi; show?: "all" | "dates"; initial?: PlanEditorValue }) {
  const [value, setValue] = useState(initial);
  return <PlanEditor show={show} location={exampleLocation} regionKey="US-NC" value={value} onChange={setValue} api={api} />;
}

describe("automatic date lookup", () => {
  it("looks up a missing date once, asks for the dates again and shows the found date with its AI label", async () => {
    const api = planApi({ entries: [entry("soybean", "next")] });
    render(<Plan api={api} />);
    await tick(10);
    expect(api.autofill).toHaveBeenCalledTimes(1);
    expect(api.calendarResearch).toHaveBeenCalledTimes(1);
    expect(api.calendarResearch).toHaveBeenCalledWith("soybean", "US-NC", expect.any(AbortSignal));
    expect(screen.getByRole("status")).toHaveTextContent("Looking up typical planting and harvest dates for Soybean… This usually takes under a minute.");
    expect(dateValue("Planting date")).toBe("");
    await tick(2000); await tick(10);
    expect(api.calendarResearchJob).toHaveBeenCalledWith("cal-soybean", expect.any(AbortSignal));
    expect(api.autofill).toHaveBeenCalledTimes(2);
    expect(dateValue("Planting date")).toBe("05-10");
    expect(screen.getByText("AI suggestion, not verified")).toBeInTheDocument();
    expect(screen.getByText("Dates marked AI-found came from a lookup of published guidance for your area. Check them against what you do.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await tick(10_000);
    expect(api.calendarResearch).toHaveBeenCalledTimes(1);
  });
  it("looks nothing up when research is unavailable, already done, or nothing is missing", async () => {
    const apis = [planApi({ available: false, entries: [entry("soybean", "next")] }), planApi({ entries: [entry("soybean", "next", { researched_at: "2026-01-01T00:00:00Z" })] }), planApi({ entries: [entry("soybean", "next", { missing: false })] })];
    for (const api of apis) { const view = render(<Plan api={api} />); await tick(10); view.unmount(); }
    const response = await base.autofill({ location: exampleLocation, crops: [{ role: "next", crop_id: "soybean" }] }); // older server: no new fields
    const old = planApi({ entries: [] }); old.autofill.mockResolvedValue({ ...response, research: undefined, calendar_research: undefined });
    render(<Plan api={old} />); await tick(10);
    for (const api of [...apis, old]) expect(api.calendarResearch).not.toHaveBeenCalled();
  });
  it("does not start a second lookup for the same crop and region after a remount", async () => {
    const api = planApi({ entries: [entry("soybean", "next")], finish: false });
    const first = render(<Plan api={api} />);
    await tick(10); await tick(2100); await tick(10);
    expect(screen.getByText("No published dates found for Soybean in this area. Enter the dates you use.")).toBeInTheDocument();
    expect(screen.queryByText("No typical date for Soybean.")).not.toBeInTheDocument();
    first.unmount();
    render(<Plan api={api} />); await tick(5000);
    expect(api.calendarResearch).toHaveBeenCalledTimes(1);
  });
  it("keeps a date the grower typed while the lookup runs", async () => {
    const api = planApi({ entries: [entry("soybean", "next")] });
    render(<Plan api={api} />);
    await tick(10);
    setDate("Planting date", "06-01");
    await tick(10); await tick(2100); await tick(10);
    expect(api.autofill).toHaveBeenCalledTimes(2);
    expect(dateValue("Planting date")).toBe("06-01");
    expect(screen.getByText("You entered")).toBeInTheDocument();
  });
  it("stops on request, and starts a new lookup after a failure when asked", async () => {
    const stopped = planApi({ entries: [entry("soybean", "next")] });
    const view = render(<Plan api={stopped} />);
    await tick(10);
    fireEvent.click(screen.getByRole("button", { name: "Stop looking up dates for Soybean" }));
    await tick(10_000);
    expect(screen.queryByText(/Looking up typical planting/)).not.toBeInTheDocument();
    expect(stopped.calendarResearch).toHaveBeenCalledTimes(1); expect(stopped.calendarResearchJob).not.toHaveBeenCalled();
    view.unmount();
    resetCalendarLookupsForTests();
    const failing = planApi({ entries: [entry("soybean", "next")], jobStatus: "failed" });
    render(<Plan api={failing} />);
    await tick(10); await tick(2100); await tick(10);
    expect(screen.getByText("No guidance found.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again to look up dates for Soybean" }));
    await tick(10);
    expect(failing.calendarResearch).toHaveBeenCalledTimes(2);
  });
  it("looks up two crops one after the other", async () => {
    const api = planApi({ entries: [entry("field_corn", "previous"), entry("soybean", "next")] });
    render(<Plan api={api} initial={blankPlan(true)} />);
    await tick(10);
    expect(api.calendarResearch).toHaveBeenCalledTimes(1);
    expect(api.calendarResearch).toHaveBeenLastCalledWith("field_corn", "US-NC", expect.any(AbortSignal));
    expect(screen.getByText("Waiting to look up dates for Soybean.")).toBeInTheDocument();
    await tick(10); await tick(2100); await tick(10);
    expect(api.calendarResearch).toHaveBeenCalledTimes(2);
    expect(api.calendarResearch).toHaveBeenLastCalledWith("soybean", "US-NC", expect.any(AbortSignal));
    await tick(10); await tick(2100); await tick(10);
    expect(api.calendarResearch).toHaveBeenCalledTimes(2);
    expect(dateValue("Harvest date")).toBe("10-02");
    expect(dateValue("Planting date")).toBe("05-10");
  });
  it("in the full editor looks up dates only after the grower has asked for typical dates", async () => {
    const api = planApi({ entries: [entry("soybean", "next")] });
    render(<Plan api={api} show="all" />);
    await tick(5000);
    expect(api.autofill).not.toHaveBeenCalled(); expect(api.calendarResearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fill typical dates" }));
    await tick(10);
    expect(api.autofill).toHaveBeenCalledTimes(1);
    expect(api.calendarResearch).toHaveBeenCalledTimes(1);
    await tick(10); await tick(2100); await tick(10);
    expect(dateValue("Next planting")).toBe("05-10");
  });
});

describe("research endpoints", () => {
  it("post only the crop and region, and read the job by id", async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ meta: {}, job_id: "j/1", job_status: "pending" }) }));
    const api = createInputsApi("https://example.invalid/", fetch);
    const signal = new AbortController().signal;
    await api.economicsResearch("soybean", "US-NC", signal);
    await api.economicsResearch("soybean", "US-NC", signal, true);
    await api.economicsResearchJob("j/1", signal);
    await api.calendarResearch("soybean", "US-NC", signal);
    await api.calendarResearchJob("j/1", signal);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["https://example.invalid/v1/economics/research", "https://example.invalid/v1/economics/research", "https://example.invalid/v1/economics/research/j%2F1", "https://example.invalid/v1/calendars/research", "https://example.invalid/v1/calendars/research/j%2F1"]);
    const bodies = fetch.mock.calls.map(call => (call[1] as { body?: string }).body);
    expect(JSON.parse(bodies[0]!)).toEqual({ crop_id: "soybean", region_key: "US-NC" });
    expect(JSON.parse(bodies[1]!)).toEqual({ crop_id: "soybean", region_key: "US-NC", refresh: true });
    expect(JSON.parse(bodies[3]!)).toEqual({ crop_id: "soybean", region_key: "US-NC" });
    expect(bodies[2]).toBeUndefined();
  });
});
