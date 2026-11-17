import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { canDraw3d, FarmSpin } from "./FarmSpin";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the start page's turning farm", () => {
  it("shows nothing where the browser cannot draw 3D, so the button stands alone", () => {
    expect(canDraw3d()).toBe(false);
    const { container } = render(<FarmSpin />);
    expect(container.firstChild).toBeNull();
  });

  it("is decoration: hidden from screen readers, with its space kept before the picture arrives", async () => {
    vi.stubGlobal("WebGLRenderingContext", function WebGLRenderingContext() {});
    // The 3D code cannot start here (there is no graphics card); the page must not break.
    const { container } = render(<FarmSpin />);
    const box = container.querySelector(".dh-farm");
    expect(box).not.toBeNull();
    expect(box?.getAttribute("aria-hidden")).toBe("true");
    expect(box?.getAttribute("data-on")).toBe("no");
    expect(box?.querySelector("canvas")).not.toBeNull();
    // When the 3D code fails to start, the empty space goes away instead of leaving a gap.
    await waitFor(() => expect(container.querySelector(".dh-farm")).toBeNull());
  });
});
