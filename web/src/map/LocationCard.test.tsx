import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import capsPerg from "../api/fixtures/capabilities-pergamino.json";
import reversePerg from "../api/fixtures/geo-reverse-pergamino.json";
import { parseCapabilities, parseReverse } from "./geoApi";
import { LocationCard, type Pick } from "./LocationCard";

const place = parseReverse(reversePerg);
const caps = parseCapabilities(capsPerg);
if (!place.ok || !caps.ok) throw new Error("fixtures did not parse");

const ready: Pick = { point: { latitude: -33.89, longitude: -60.57 }, place: { state: "ready", data: place.data }, caps: { state: "ready", data: caps.data } };

describe("LocationCard", () => {
  it("shows place, climate, cell and every capability status", () => {
    render(<LocationCard pick={ready} />);
    expect(screen.getByRole("heading", { name: "Pergamino, Buenos Aires, Argentina" })).toBeInTheDocument();
    expect(screen.getByText("Cfa · Humid subtropical")).toBeInTheDocument();
    expect(screen.getByText("lat-34.00_lon-60.625")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Capabilities" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(within(list).getByText("Crop guidance").closest("li")).toHaveAttribute("data-status", "partial");
  });

  it("never labels AI suggestions as verified", () => {
    render(<LocationCard pick={ready} />);
    const catalog = screen.getByText("Crop guidance").closest("li")!;
    expect(catalog.textContent).toMatch(/not verified/);
    expect(catalog.textContent).not.toMatch(/Published guidance/);
  });

  it("shows loading and errors without inventing values", () => {
    render(<LocationCard pick={{ point: ready.point, place: { state: "loading" }, caps: { state: "error", message: "The service could not be reached." } }} />);
    expect(screen.getByRole("heading", { name: "Finding this place…" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("could not be reached");
    expect(screen.queryByRole("list", { name: "Capabilities" })).toBeNull();
  });
});
