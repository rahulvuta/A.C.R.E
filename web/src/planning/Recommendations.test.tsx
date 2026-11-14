import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Recommendations } from "./Recommendations";
import { createGoalsPanelValue } from "./GoalsPanel";
import { candidate, field, insufficient, jsonResponse, point, recommendation } from "./test-fixtures";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const callbacks = () => ({
  onUsePlan: vi.fn(),
  onEditPlan: vi.fn(),
  onPlanManually: vi.fn(),
  onReplay: vi.fn()
});
it("calls recommend, explains the rye plan and displays units without a composite number", async () => {
  const fetch = vi.fn().mockResolvedValue(jsonResponse(recommendation));
  vi.stubGlobal("fetch", fetch);
  const actions = callbacks();
  const {
    container
  } = render(<Recommendations location={point} field={field} {...actions} />);
  await screen.findByRole("heading", {
    name: "Rye cover rotation"
  });
  expect(fetch.mock.calls[0]![0]).toMatch(/\/v1\/plans\/recommend$/);
  expect(JSON.parse(fetch.mock.calls[0]![1].body).field).toEqual(field);
  expect(screen.getAllByText(candidate.why[0]!.text)[0]).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/score|weighted total|overall rating/i);
  const table = screen.getByRole("table");
  const rainRow = within(table).getByRole("row", {
    name: /rain on bare soil mm/
  });
  expect(within(rainRow).getByText("40.6")).toBeInTheDocument();
  expect(within(rainRow).getAllByText("mm per season")).toHaveLength(2);
  expect(within(rainRow).getByText("37.8").closest("td")).toHaveAttribute("data-best", "true");
  fireEvent.click(screen.getAllByRole("button", {
    name: "Use this plan"
  })[0]!);
  expect(actions.onUsePlan).toHaveBeenCalledWith(expect.objectContaining({
    candidate_id: "rye"
  }));
  fireEvent.click(screen.getAllByRole("button", {
    name: "Edit this plan"
  })[0]!);
  expect(actions.onEditPlan).toHaveBeenCalledWith(expect.objectContaining({
    candidate_id: "rye"
  }));
  expect(screen.getByText("Dominated plans (1)").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByText("Not comparable (1)").closest("details")).not.toHaveAttribute("open");
  const history = screen.getAllByText("Historical vulnerabilities (1)")[0]!;
  fireEvent.click(history);
  fireEvent.click(screen.getAllByRole("button", {
    name: "Replay 1990"
  })[0]!);
  expect(actions.onReplay).toHaveBeenCalledWith(candidate.historical_vulnerabilities[0]!.replay);
});
it("shows evidence gaps and manual planning for insufficient_data", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(insufficient)));
  const actions = callbacks();
  render(<Recommendations location={point} {...actions} />);
  expect(await screen.findByText(insufficient.gaps[0]!)).toBeInTheDocument();
  expect(screen.getByText(insufficient.gaps[1]!)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {
    name: "Plan manually"
  }));
  expect(actions.onPlanManually).toHaveBeenCalledOnce();
});
it("uses returned ordering after weight changes without altering indicator values", async () => {
  const fetch = vi.fn().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({
      ...recommendation,
      shortlist: body.goals.priorities.management_simplicity === 3 ? [...recommendation.shortlist].reverse() : recommendation.shortlist
    });
  });
  vi.stubGlobal("fetch", fetch);
  const goals = createGoalsPanelValue().goals;
  const actions = callbacks();
  const {
    rerender
  } = render(<Recommendations location={point} goals={goals} {...actions} />);
  await screen.findByRole("heading", {
    name: "Rye cover rotation"
  });
  rerender(<Recommendations location={point} goals={{
    ...goals,
    priorities: {
      ...goals.priorities,
      management_simplicity: 3
    }
  }} {...actions} />);
  await waitFor(() => expect(screen.getAllByRole("article")[0]).toHaveTextContent("Grain rotation"));
  expect(within(screen.getByRole("table")).getByText("40.6")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("preserves zero, exposes missing indicators and recovers from network errors", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValueOnce(jsonResponse({
    ...recommendation,
    shortlist: [{
      ...candidate,
      indicators: {
        rain_on_bare_soil_mm: {
          ...candidate.indicators.rain_on_bare_soil_mm,
          value: 0
        },
        management_operations: {
          ...candidate.indicators.management_operations,
          value: null,
          status: "unknown",
          reason: "Not reported"
        }
      }
    }]
  }));
  vi.stubGlobal("fetch", fetch);
  render(<Recommendations location={point} {...callbacks()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
  fireEvent.click(screen.getByRole("button", {
    name: "Try again"
  }));
  await screen.findByRole("heading", {
    name: "Rye cover rotation"
  });
  expect(within(screen.getByRole("table")).getByText("0")).toBeInTheDocument();
  expect(within(screen.getByRole("table")).getByText("Not available")).toBeInTheDocument();
});
