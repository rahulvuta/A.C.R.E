import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const go = (url: string) => window.history.replaceState(null, "", url);

describe("routes", () => {
  afterEach(() => {
    go("/");
    vi.unstubAllGlobals();
  });

  it("the root URL opens the empty dashboard: no sign-in, Add Field and Explore Demo Farm", () => {
    go("/");
    render(<App />);
    expect(screen.getByRole("heading", { name: "No fields available" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explore Demo Farm" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Add field/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/sign in|log in|sign up/i)).toBeNull();
  });

  it("?view=app opens the guided simulator at step 1 with the demo farms", async () => {
    go("/?view=app");
    render(<App />);
    // Routes other than the dashboard load on demand.
    expect(await screen.findByRole("heading", { name: "Where is your farm?" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Try a demo farm" })).toBeInTheDocument();
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
