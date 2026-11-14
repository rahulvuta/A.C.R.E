import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningPreview, RecordPlaceholder } from "./PlanningStory";

afterEach(cleanup);

describe("planning workflow illustration", () => {
  it("supports keyboard selection and keeps the active panel associated with its tab", () => {
    render(<PlanningPreview />);
    const field = screen.getByRole("tab", { name: "Your field" });
    const goals = screen.getByRole("tab", { name: "Your goals" });
    const future = screen.getByRole("tab", { name: "Your future plan" });

    fireEvent.keyDown(field, { key: "ArrowRight" });
    expect(goals).toHaveFocus();
    expect(goals).toHaveAttribute("aria-selected", "true");
    expect(field).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Your goals" })).toHaveTextContent("Crop history, equipment and date limits");

    fireEvent.keyDown(goals, { key: "End" });
    expect(future).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Your future plan" })).toHaveTextContent("Sourced dates · Your dates · Assumptions");

    fireEvent.keyDown(future, { key: "ArrowRight" });
    expect(field).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Your field" })).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "ArrowLeft" });
    expect(future).toHaveFocus();
    fireEvent.keyDown(future, { key: "Home" });
    expect(field).toHaveFocus();
  });

  it("lets pointer users inspect options and clearly labels the illustration", () => {
    render(<PlanningPreview />);
    fireEvent.click(screen.getByRole("tab", { name: "Your options" }));
    expect(screen.getByRole("tabpanel", { name: "Your options" })).toHaveTextContent("Trade-offs, evidence gaps and uncertainty");
    expect(screen.getByText("Workflow illustration")).toBeInTheDocument();
  });
});

it("offers the existing saved demo when the marketing record cannot load", () => {
  const { rerender } = render(<RecordPlaceholder failed={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading the worked example");
  rerender(<RecordPlaceholder failed />);
  expect(screen.getByRole("status")).toHaveTextContent("could not be loaded");
  expect(screen.getByRole("link", { name: /Open the NC demo to retry/ })).toHaveAttribute("href", "?view=demo");
});
