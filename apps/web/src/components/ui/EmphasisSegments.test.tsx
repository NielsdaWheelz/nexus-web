import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import EmphasisSegments from "./EmphasisSegments";

describe("EmphasisSegments", () => {
  it("renders text segments safely with semantic emphasis", () => {
    render(
      <EmphasisSegments
        emphasisClassName="match"
        segments={[
          { text: "Before ", emphasized: false },
          { text: "<match>", emphasized: true },
          { text: " after", emphasized: false },
        ]}
      />,
    );

    expect(screen.getByText("<match>")).toHaveProperty("tagName", "MARK");
    expect(screen.getByText("<match>")).toHaveClass("match");
    expect(screen.queryByText("<match>", { selector: "script" })).toBeNull();
  });
});
