import { cleanup, render } from "@testing-library/react";
import { ORIGIN_LABEL } from "../ui/OriginBadge";
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OriginBadge } from "./shared";
afterEach(cleanup);
it("gives sourced, estimated, grower and assumed dates visibly distinct styles and literal labels", () => {
  const origins = ["verified_source", "dataset_estimate", "grower", "assumed"] as const;
  const css = readFileSync("src/planning/planning.css", "utf8");
  const {
    container
  } = render(<div className="pl"><style>{css.replace(/@import[^;]+;/, "")}</style>{origins.map(origin => <OriginBadge origin={origin} key={origin} />)}</div>);
  const styles = origins.map(origin => {
    const badge = container.querySelector(`[data-origin="${origin}"]`)!;
    expect(badge).toHaveTextContent(ORIGIN_LABEL[origin]);
    const computed = getComputedStyle(badge);
    return [computed.backgroundColor, computed.borderStyle, computed.fontStyle, computed.borderWidth].join("|");
  });
  expect(new Set(styles).size).toBe(4);
});
