import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PaneStrip from "@/components/workspace/PaneStrip";

describe("PaneStrip", () => {
  it("renders adjacent pane wrappers in a single horizontal strip", () => {
    render(
      <PaneStrip>
        <div>Pane A</div>
        <div>Pane B</div>
      </PaneStrip>
    );

    const strip = screen.getByTestId("pane-strip");
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveStyle({
      display: "flex",
      flexDirection: "row",
      overflowX: "auto",
      overflowY: "hidden",
      gap: "0",
    });
    expect(screen.getByText("Pane A")).toBeInTheDocument();
    expect(screen.getByText("Pane B")).toBeInTheDocument();
  });
});
