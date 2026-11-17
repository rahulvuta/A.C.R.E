import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const go = (url: string) => window.history.replaceState(null, "", url);

describe("routes", () => {
  afterEach(() => {
    go("/");
    vi.unstubAllGlobals();
  });

  it("the root URL opens the welcome screen when no field is saved: no sign-in, the six steps, one way to start", () => {
    go("/");
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: /holds up over the next 10 years/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start with my field" })).toHaveAttribute("href", "?view=app");
    expect(within(screen.getByRole("region", { name: "The six steps" })).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.queryByText(/sign in|log in|sign up/i)).toBeNull();
  });

  it("a link into the fields list opens the start page: one big button, example farms folded away", () => {
    go("/#d=fields");
    render(<App />);
    expect(screen.getByRole("button", { name: "Create your farm" })).toBeInTheDocument();
    expect(screen.getByText("Example farms")).toBeInTheDocument();
    expect(screen.queryByText(/sign in|log in|sign up/i)).toBeNull();
  });

  it("?view=app opens the guided simulator at step 1 with the demo farms", async () => {
    go("/?view=app");
    render(<App />);
    // Routes other than the dashboard load on demand.
    expect(await screen.findByRole("heading", { name: "Where is your farm?" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Try an example farm" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Union County deep-dive/ })).toBeNull();
  });

  it("?view=fields still opens the per-field workspace", async () => {
    go("/?view=fields");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Find your farm" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Union County demo/ })[0]).toHaveAttribute("href", "?view=demo");
  });

  it("?view=demo and old planner links open the saved demo", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    for (const url of ["/?view=demo", "/?view=app#s=cover&pg=rye", "/#pg=springs"]) {
      go(url);
      const { unmount } = render(<App />);
      expect(screen.getByRole("status")).toHaveTextContent(/saved NASA weather sample for Union County/);
      unmount();
    }
  });
});
