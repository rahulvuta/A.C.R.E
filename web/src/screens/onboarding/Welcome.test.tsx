import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalClient } from "../../api/client";
import { FIXTURE_API_BASE, fixtureFetch } from "../../api/fixtures";
import { geoApiFrom } from "../../api/geoApi";
import { createFarmStore, type FarmStoreHandle } from "../../farm/store";
import { resetFarmStoreForTests } from "../../farm/hooks";
import { getSimField, resetSimFieldsForTests } from "../../state/simField";
import type { GlobalApi } from "../../state/useGlobal";
import { STEPS } from "../guided/steps";
import { Welcome } from "./Welcome";

const client = createGlobalClient({ apiBase: FIXTURE_API_BASE, timeoutMs: 2000, fetchImpl: fixtureFetch() });
const api: GlobalApi = { client, geo: geoApiFrom(client), source: "fixtures" };
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("welcome screen", () => {
  let store: FarmStoreHandle;
  beforeEach(() => { store = createFarmStore(mem()); resetFarmStoreForTests(store); resetSimFieldsForTests(); });
  afterEach(() => { cleanup(); resetFarmStoreForTests(); });

  it("lays out the six steps of the sequence in order, with the same names the sequence uses", () => {
    render(<Welcome api={api} go={() => {}} />);
    const items = within(screen.getByRole("region", { name: "The six steps" })).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("strong")?.textContent)).toEqual(STEPS.map((s) => s.nav));
    items.forEach((li, i) => expect(li).toHaveTextContent(STEPS[i]!.question));
  });

  it("starts the sequence at step 1 and asks for no account", () => {
    render(<Welcome api={api} go={() => {}} />);
    expect(screen.getByRole("link", { name: "Start with my field" })).toHaveAttribute("href", "?view=app");
    expect(screen.queryByText(/log ?in|sign ?(in|up)|password/i)).toBeNull();
  });

  it("the example farm is loaded as a demo, selected, and opens the sequence filled in", async () => {
    const go = vi.fn();
    render(<Welcome api={api} go={go} />);
    fireEvent.click(screen.getByRole("button", { name: "See an example farm" }));
    // Two real places are offered; no country is loaded by default.
    expect(within(screen.getByRole("group", { name: "Example farms" })).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Argentina/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("?view=app#u=now&p=crops"));
    const state = store.get();
    const farm = state.farms.find((f) => f.fields.length > 0)!;
    expect(farm.demo).toBeTruthy();
    expect(state.selected_field_id).toBe(farm.fields[0]!.field_id);
    expect(getSimField(farm.fields[0]!.field_id).rotation.length).toBeGreaterThan(0);
  });

  it("without a connected service the example is the saved Union County demo", () => {
    render(<Welcome api={{ ...api, source: "none" }} go={() => {}} />);
    expect(screen.getByRole("link", { name: "See an example farm" })).toHaveAttribute("href", "?view=demo");
  });
});
