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

  it("?view=app opens the guided simulator at step 1, with the demo farms and the deep-dive", () => {
    go("/?view=app");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Where is your farm?" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Try a demo farm" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Union County deep-dive/ })).toHaveAttribute("href", "?view=demo");
  });

  it("?view=fields still opens the per-field workspace", () => {
    go("/?view=fields");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Find your farm" })).toBeInTheDocument();
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
