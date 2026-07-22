import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import RunningHead from "./RunningHead";

describe("RunningHead", () => {
  it("renders the standing head flush-left and a count folio flush-right", () => {
    render(
      <RunningHead
        id="section-identity"
        standingHead="Libraries"
        folio={{ kind: "count", value: 37, unit: "source" }}
      />,
    );
    expect(screen.getByText("Libraries")).toBeInTheDocument();
    expect(screen.getByText("37 sources")).toBeInTheDocument();
  });

  it("renders a title folio for the reader", () => {
    render(
      <RunningHead
        id="section-identity"
        standingHead="Libraries"
        folio={{ kind: "title", value: "The Pragmatic Programmer" }}
      />,
    );
    expect(screen.getByText("The Pragmatic Programmer")).toBeInTheDocument();
  });

  it("renders a formatted date folio", () => {
    render(
      <RunningHead
        id="section-identity"
        standingHead="Notes"
        folio={{ kind: "date", iso: "2026-07-07" }}
      />,
    );
    expect(screen.getByText(/Jul/)).toBeInTheDocument();
  });

  it("renders no folio text for a none folio", () => {
    render(
      <RunningHead id="section-identity" standingHead="Search" folio={{ kind: "none" }} />,
    );
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("exposes accessible loading text while the folio is pending", () => {
    render(
      <RunningHead
        id="section-identity"
        standingHead="Libraries"
        folio={{ kind: "count", value: 0, unit: "source" }}
        folioPending
      />,
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("0 sources")).toBeNull();
  });

  it("keeps the standing head text natural-case in the DOM (CSS uppercases it)", () => {
    render(<RunningHead id="section-identity" standingHead="Podcasts" />);
    expect(screen.getByText("Podcasts").textContent).toBe("Podcasts");
  });

  it("renders the standing head as a label, not a heading", () => {
    render(<RunningHead id="section-identity" standingHead="Chats" />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
