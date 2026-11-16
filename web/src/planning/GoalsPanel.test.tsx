import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GoalsPanel, createGoalsPanelValue, type GoalsPanelValue } from "./GoalsPanel";
import { recommendPlans } from "./api";
import { insufficient, jsonResponse, point } from "./test-fixtures";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Controlled({
  onValue
}: {
  onValue: (value: GoalsPanelValue) => void;
}) {
  const [value, setValue] = useState(createGoalsPanelValue);
  return <GoalsPanel value={value} onChange={next => {
    setValue(next);
    onValue(next);
  }} />;
}
it("keeps all six priorities controlled, preserves unknowns and performs no storage or fetch", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const changed = vi.fn();
  render(<Controlled onValue={changed} />);
  expect(screen.getAllByRole("slider")).toHaveLength(6);
  fireEvent.change(screen.getByRole("slider", {
    name: "Soil cover"
  }), {
    target: {
      value: "0"
    }
  });
  expect(changed.mock.lastCall?.[0].goals.priorities.soil_cover).toBe(0);
  expect(changed.mock.lastCall?.[0].goals.constraints.irrigation).toBe("unknown");
  expect(changed.mock.lastCall?.[0].goals.constraints.allowed_crops).toBeNull();
  expect(changed.mock.lastCall?.[0].goals.constraints.latest_planting).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
  storage.mockRestore();
});
it("separates preferences and constraints, supports equipment and crop history", () => {
  const changed = vi.fn();
  render(<Controlled onValue={changed} />);
  expect(screen.getByRole("region", {
    name: "Hard constraints"
  })).not.toContainElement(screen.getByLabelText("Liked crops"));
  fireEvent.change(screen.getByLabelText("Liked crops"), {
    target: {
      value: "soybean, cereal_rye"
    }
  });
  fireEvent.blur(screen.getByLabelText("Liked crops"));
  expect(changed.mock.lastCall?.[0].goals.preferences.liked_crops).toEqual(["soybean", "cereal_rye"]);
  expect(changed.mock.lastCall?.[0].goals.constraints.must_include).toEqual([]);
  fireEvent.click(screen.getByLabelText("No roller crimper"));
  expect(changed.mock.lastCall?.[0].goals.constraints.equipment).toEqual(["no_roller_crimper"]);
  fireEvent.change(screen.getByLabelText("Previous crops"), {
    target: {
      value: "field_corn, soybean"
    }
  });
  fireEvent.blur(screen.getByLabelText("Previous crops"));
  expect(changed.mock.lastCall?.[0].crop_history).toEqual(["field_corn", "soybean"]);
});
it("serializes unknown irrigation as unknown after a yes → unknown change", async () => {
  const fetch = vi.fn().mockResolvedValue(jsonResponse(insufficient));
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  render(<Controlled onValue={changed} />);
  fireEvent.change(screen.getByLabelText("Irrigation"), {
    target: {
      value: "yes"
    }
  });
  fireEvent.change(screen.getByLabelText("Irrigation"), {
    target: {
      value: "unknown"
    }
  });
  await recommendPlans({
    location: point,
    goals: changed.mock.lastCall![0].goals
  });
  const body = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(body.goals.constraints.irrigation).toBe("unknown");
  expect(body.goals.constraints.irrigation).not.toBe(false);
});
