import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanningFlow } from "./PlanningFlow";
import { field, futureResponse, generated, insufficient, jsonResponse, point, recommendation } from "./test-fixtures";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("chains goals, recommendation, provenance recovery and future plan", async () => {
  const fetch = vi.fn().mockImplementation(async (url, init) => jsonResponse(String(url).endsWith("/recommend") ? recommendation : String(url).endsWith("/generate") ? generated : futureResponse(JSON.parse(init.body))));
  vi.stubGlobal("fetch", fetch);
  render(<PlanningFlow location={point} field={field} />);
  fireEvent.click(screen.getByRole("button", {
    name: "Find plans for this field"
  }));
  await screen.findByRole("heading", {
    name: "Rye cover rotation"
  });
  fireEvent.click(screen.getAllByRole("button", {
    name: "Use this plan"
  })[0]!);
  await screen.findByRole("heading", {
    name: "2027"
  });
  expect(fetch.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining([expect.stringMatching(/\/recommend$/), expect.stringMatching(/\/generate$/), expect.stringMatching(/\/future$/)]));
  const futureBody = JSON.parse(fetch.mock.calls.find(c => String(c[0]).endsWith("/future"))![1].body);
  expect(futureBody.candidate.seasons[0].origins["winter.seed"]).toBe("verified_source");
  const recommendBody = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(recommendBody.goals.constraints.irrigation).toBe("unknown");
  expect(recommendBody.field.crop_history).toEqual(field.crop_history);
});
it("refuses to relabel a generated plan when original date provenance cannot be recovered", async () => {
  const fetch = vi.fn().mockImplementation(async url => jsonResponse(String(url).endsWith("/recommend") ? recommendation : {
    ...generated,
    candidates: []
  }));
  vi.stubGlobal("fetch", fetch);
  render(<PlanningFlow location={point} field={field} />);
  fireEvent.click(screen.getByRole("button", {
    name: "Find plans for this field"
  }));
  await screen.findByRole("heading", {
    name: "Rye cover rotation"
  });
  fireEvent.click(screen.getAllByRole("button", {
    name: "Edit this plan"
  })[0]!);
  expect(await screen.findByRole("alert")).toHaveTextContent("date origins can be preserved");
  expect(fetch.mock.calls.some(c => String(c[0]).endsWith("/future"))).toBe(false);
});
it("provides a manual editor without guessed crops or dates", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(insufficient)));
  render(<PlanningFlow location={point} field={field} />);
  fireEvent.click(screen.getByRole("button", {
    name: "Find plans for this field"
  }));
  await screen.findByRole("button", {
    name: "Plan manually"
  });
  fireEvent.click(screen.getByRole("button", {
    name: "Plan manually"
  }));
  await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(8));
  expect(screen.getAllByRole("textbox").every(input => (input as HTMLInputElement).value === "")).toBe(true);
});
