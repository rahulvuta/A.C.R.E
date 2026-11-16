import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldPlan } from "../../farm/types";
import { createExampleInputsApi } from "../../inputs/examples";
import { getSimField, resetSimFieldsForTests, updateSimField } from "../../state/simField";
import type { StepContext } from "./context";
import { FarmFit, FitCaution, PermanentSeason } from "./FarmFit";
import { permanentSeason } from "./farmSystem";

const field = { field_id: "f1", name: "Shamba", geometry: { type: "Polygon" as const, coordinates: [[[35, 1], [35.01, 1], [35.01, 1.01], [35, 1.01], [35, 1]]] }, plan: null };
const maizeBeans: FieldPlan = { plan_id: "season_1", label: "Season 1", previous_crop_id: "maize", prev_harvest: "10-31", winter: { kind: "none" }, next_crop_id: "dry_beans", next_plant: "03-15" };
const inputs = createExampleInputsApi();
const ctxFor = (rotation: FieldPlan[]) => ({ field, sim: { ...getSimField("f1"), rotation }, point: { latitude: 1.02, longitude: 35 }, regionKey: "KE-42", api: { client: { inputs }, source: "fixtures" } }) as unknown as StepContext;

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { get length() { return values.size; }, clear: () => values.clear(), getItem: (k: string) => values.get(k) ?? null, key: (i: number) => [...values.keys()][i] ?? null, removeItem: (k: string) => values.delete(k), setItem: (k: string, v: string) => values.set(k, String(v)) } satisfies Storage });
  resetSimFieldsForTests();
});
afterEach(cleanup);

describe("what will be simulated, and what does not fit (card 21)", () => {
  it("says a single season is the second crop every year and asks whether the two take turns", () => {
    const onChange = vi.fn();
    render(<FarmFit ctx={ctxFor([maizeBeans])} rotation={[maizeBeans]} onChange={onChange} />);
    const box = screen.getByRole("region", { name: "What will be simulated" });
    expect(box).toHaveTextContent("Every year: dry beans.");
    expect(box).toHaveTextContent("Maize is only what was on the field before the first year. As entered, it is not grown again.");
    fireEvent.click(within(box).getByRole("button", { name: "Yes, grow maize again after dry beans" }));
    const next = onChange.mock.calls[0]![0] as FieldPlan[];
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ previous_crop_id: "dry_beans", next_crop_id: "maize", prev_harvest: "", next_plant: "" });
  });

  it("two harvests a year keeps the dates already entered and their labels", () => {
    updateSimField("f1", { planInputs: { season_1: { dates: [{ field: "prev_harvest", value: "10-31", origin: "grower" }, { field: "next_plant", value: "03-15", origin: "grower" }], cropDetails: [] } } });
    const onChange = vi.fn();
    render(<FarmFit ctx={ctxFor([maizeBeans])} rotation={[maizeBeans]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "I grow both every year" }));
    expect(onChange.mock.calls[0]![0]).toEqual([{ ...maizeBeans, next_crop_id: "maize", next_plant: "", winter: { kind: "winter_grain", crop_id: "dry_beans", plant: "03-15", harvest: "" } }]);
    expect(getSimField("f1").planInputs!.season_1!.dates).toEqual([{ field: "prev_harvest", value: "10-31", origin: "grower" }, { field: "winter.plant", value: "03-15", origin: "grower" }]);
  });

  it("a plan that leads back to its first crop is only said back, with no question", () => {
    const both = [maizeBeans, { ...maizeBeans, plan_id: "season_2", previous_crop_id: "dry_beans", next_crop_id: "maize" }];
    render(<FarmFit ctx={ctxFor(both)} rotation={both} onChange={() => {}} />);
    expect(screen.getByRole("region", { name: "What will be simulated" })).toHaveTextContent("Year 1: dry beans. Year 2: maize. Then it starts again.");
    expect(screen.queryByRole("button", { name: /take turns|grow maize again/ })).toBeNull();
  });

  it("offers “My farm does not fit this”, and what is ticked is said on the results", () => {
    render(<FarmFit ctx={ctxFor([maizeBeans])} rotation={[maizeBeans]} onChange={() => {}} />);
    expect(screen.getByText("My farm does not fit this")).toBeInTheDocument();
    expect(screen.getByText("Two crops grow together in the same field")).toBeInTheDocument();
    expect(screen.getByText("A crop that stays in the ground for years")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /I water the field when it does not rain/ }));
    expect(getSimField("f1").fitNotes).toEqual(["irrigated"]);
    cleanup();
    render(<FitCaution ids={getSimField("f1").fitNotes} notes={[{ text: "Dry beans is grown together with maize and counted in the money in the same season." }]} />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Dry beans is grown together with maize");
    expect(note).toHaveTextContent("counts rain only");
    cleanup();
    const { container } = render(<FitCaution ids={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a long-lived crop shows its own card: sold or not, a harvest date, and the way back", () => {
    const onChange = vi.fn();
    const onYearly = vi.fn();
    const coffee = permanentSeason("coffee", true);
    render(<PermanentSeason plan={coffee} show="all" onChange={onChange} onYearly={onYearly} />);
    const card = screen.getByRole("region", { name: "Coffee, in the ground all year" });
    expect(card).toHaveTextContent("Nothing is planted each season and the ground is never bare.");
    fireEvent.change(within(card).getByRole("combobox", { name: "Harvest date: day" }), { target: { value: "15" } });
    fireEvent.change(within(card).getByRole("combobox", { name: "Harvest date: month" }), { target: { value: "11" } });
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ prev_harvest: "11-15", next_plant: "11-15", permanent: { sold: true } });
    fireEvent.click(within(card).getByRole("button", { name: "Nothing is sold from it" }));
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ permanent: { sold: false }, next_crop_id: "coffee" });
    fireEvent.click(within(card).getByRole("button", { name: "Change back to crops planted every year" }));
    expect(onYearly).toHaveBeenCalled();
  });
});
