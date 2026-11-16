import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FuturePlan } from "./FuturePlan";
import { futureResponse, generated, jsonResponse, point } from "./test-fixtures";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("renders multiple seasons, origins, milestones, deadlines and backup", async () => {
  const fetch = vi.fn().mockResolvedValue(jsonResponse(futureResponse()));
  vi.stubGlobal("fetch", fetch);
  const {
    container
  } = render(<FuturePlan location={point} candidate={generated.candidates[0]} startSeason="2027" seasons={2} />);
  expect(await screen.findByRole("heading", {
    name: "2027"
  })).toBeInTheDocument();
  expect(screen.getByRole("heading", {
    name: "2028"
  })).toBeInTheDocument();
  expect(screen.getAllByText("Check cover condition")).toHaveLength(2);
  expect(screen.getAllByText("A backup plan is ready for this season.")).toHaveLength(2);
  // Empty sections are hidden, and dates read in words.
  expect(screen.queryByText(/No .* returned|No backup plan available/)).toBeNull();
  expect(container.textContent).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  expect(container.querySelector(".pl-window.pl-date-verified_source")).toHaveAttribute("data-origin", "verified_source");
  expect(container.querySelector(".pl-window.pl-date-dataset_estimate")).toHaveAttribute("data-origin", "dataset_estimate");
  expect(container.querySelector(".pl-window.pl-date-assumed")).toHaveAttribute("data-origin", "assumed");
  expect(container.querySelector(".pl-origin-verified_source")?.className).not.toBe(container.querySelector(".pl-origin-dataset_estimate")?.className);
  expect(container.textContent).not.toMatch(/score/i);
  expect(JSON.parse(fetch.mock.calls[0]![1].body).candidate.seasons[0].origins["winter.seed"]).toBe("verified_source");
});
it("sends season-specific cumulative edits, shows the returned diff and updated deadlines", async () => {
  const fetch = vi.fn().mockImplementation(async (_url, init) => jsonResponse(futureResponse(JSON.parse(init.body))));
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  const {
    container
  } = render(<FuturePlan location={point} candidate={generated.candidates[0]} startSeason="2027" seasons={2} onChange={changed} />);
  await screen.findByRole("heading", {
    name: "2027"
  });
  const editor = screen.getByLabelText("Edit End the rye cover crop, season 1");
  fireEvent.change(editor, {
    target: {
      value: "2027-04-03"
    }
  });
  fireEvent.submit(editor.closest("form")!);
  expect(await screen.findByRole("heading", {
    name: "Changes from the original plan"
  })).toBeInTheDocument();
  expect(JSON.parse(fetch.mock.calls[1]![1].body).edits).toEqual([{
    field: "winter.terminate",
    season: 1,
    value: "04-03"
  }]);
  expect(screen.getByRole("region", {
    name: "Returned plan changes"
  })).toHaveTextContent("2027-04-08 → 2027-04-03");
  expect(screen.getByRole("region", {
    name: "Returned plan changes"
  })).toHaveTextContent("2027-04-01 → 2027-03-27");
  expect(container.querySelector(".pl-window.pl-date-grower")).toHaveAttribute("data-origin", "grower");
  expect(screen.getByRole("region", {
    name: "Updated historical analysis"
  })).toHaveTextContent("42.3");
  const second = screen.getByLabelText("Edit Plant next crop, season 2");
  fireEvent.change(second, {
    target: {
      value: "2028-05-20"
    }
  });
  fireEvent.submit(second.closest("form")!);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetch.mock.calls[2]![1].body).edits).toHaveLength(2);
  expect(changed).toHaveBeenCalled();
});
it("prints the plan and can restore the original after an invalid edit", async () => {
  const print = vi.spyOn(window, "print").mockImplementation(() => {});
  const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(futureResponse())).mockResolvedValueOnce(jsonResponse({
    status: "invalid_input",
    issues: [{
      field: "edits[0]",
      message: "The edited date breaks chronology."
    }]
  }, 400)).mockResolvedValueOnce(jsonResponse(futureResponse()));
  vi.stubGlobal("fetch", fetch);
  render(<FuturePlan location={point} candidate={generated.candidates[0]} startSeason="2027" seasons={2} />);
  await screen.findByRole("heading", {
    name: "2027"
  });
  fireEvent.click(screen.getByRole("button", {
    name: "Print plan"
  }));
  expect(print).toHaveBeenCalledOnce();
  // A section the grower has folded shut is opened for printing and folded again afterwards.
  const folded = screen.getAllByText("Jobs and checks, in date order")[0]!.closest("details")!;
  folded.open = false;
  expect(folded.open).toBe(false);
  fireEvent(window, new Event("beforeprint"));
  expect(folded.open).toBe(true);
  fireEvent(window, new Event("afterprint"));
  expect(folded.open).toBe(false);
  const editor = screen.getByLabelText("Edit End the rye cover crop, season 1");
  fireEvent.change(editor, {
    target: {
      value: "2027-04-03"
    }
  });
  fireEvent.submit(editor.closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("breaks chronology");
  expect(within(screen.getByRole("article", {
    name: "2027"
  })).getByLabelText("Edit End the rye cover crop, season 1")).toBeEnabled();
  fireEvent.click(screen.getByRole("button", {
    name: "Restore original dates"
  }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(JSON.parse(fetch.mock.calls[2]![1].body).edits).toEqual([]);
});
