import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ORIGINS } from "../api/model";
import { ORIGIN_LABEL, OriginBadge, originClass } from "./OriginBadge";

describe("OriginBadge", () => {
  it("renders a label for every origin", () => {
    for (const o of ORIGINS) {
      const { unmount } = render(<OriginBadge origin={o} />);
      expect(screen.getByText(ORIGIN_LABEL[o])).toBeTruthy();
      unmount();
    }
  });
  it("never gives an AI row the verified style or wording", () => {
    for (const o of ["ai_suggested", "source_checked"] as const) {
      expect(originClass(o)).not.toBe("ob-verified");
      expect(ORIGIN_LABEL[o]).not.toMatch(/published|verified source/i);
    }
    const { container } = render(<OriginBadge origin="ai_suggested" />);
    expect(container.querySelector(".ob-verified")).toBeNull();
  });
});
