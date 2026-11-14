import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Vulnerabilities, usePlanningRequest } from "./shared";
import { candidate, jsonResponse } from "./test-fixtures";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("opens a historical replay using the exact backend request when no host callback is supplied", async () => {
  const fetch = vi.fn().mockResolvedValue(jsonResponse({
    year: 1990,
    winter: {
      status: "complete",
      rain_outside_cover_mm: 0,
      living_cover_days: 120
    },
    spring: {
      status: "partial",
      total_mm: null
    },
    checks_triggered: []
  }));
  vi.stubGlobal("fetch", fetch);
  render(<Vulnerabilities items={candidate.historical_vulnerabilities} />);
  fireEvent.click(screen.getByRole("button", {
    name: "Replay 1990"
  }));
  expect(await screen.findByRole("region", {
    name: "Historical replay"
  })).toHaveTextContent("0 mm");
  expect(screen.getByRole("region", {
    name: "Historical replay"
  })).toHaveTextContent("Not available");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(candidate.historical_vulnerabilities[0]!.replay!.body);
});
function Probe({
  id,
  loader
}: {
  id: string;
  loader: (signal: AbortSignal) => Promise<string>;
}) {
  const {
    data,
    error,
    loading
  } = usePlanningRequest(id, loader);
  return <p>{loading ? "Loading" : error ?? data}</p>;
}
it("ignores stale responses after inputs change and aborts the earlier request", async () => {
  let finish: (value: string) => void = () => {};
  let firstSignal: AbortSignal | undefined;
  const first = (signal: AbortSignal) => {
    firstSignal = signal;
    return new Promise<string>(resolve => {
      finish = resolve;
    });
  };
  const {
    rerender
  } = render(<Probe id="first" loader={first} />);
  await waitFor(() => expect(firstSignal).toBeDefined());
  rerender(<Probe id="second" loader={async () => "Current result"} />);
  expect(await screen.findByText("Current result")).toBeInTheDocument();
  expect(firstSignal?.aborted).toBe(true);
  finish("Old result");
  await waitFor(() => expect(screen.queryByText("Old result")).toBeNull());
});
it("handles a synchronous schema failure as a visible request error", async () => {
  render(<Probe id="invalid" loader={() => {
    throw new Error("Please enter a valid planting year.");
  }} />);
  expect(await screen.findByText("Please enter a valid planting year.")).toBeInTheDocument();
});
