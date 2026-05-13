import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Pill from "@/components/ui/Pill";

describe("Pill", () => {
  it("renders children with default tone, shape, and size", () => {
    render(<Pill data-testid="pill">Live</Pill>);
    const el = screen.getByTestId("pill");
    expect(el).toHaveTextContent("Live");
    expect(el.className).toMatch(/toneNeutral/);
    expect(el.className).toMatch(/shapePill/);
    expect(el.className).toMatch(/sizeSm/);
    expect(el.className).toMatch(/uppercase/);
  });

  it("applies each tone", () => {
    const tones = ["neutral", "info", "success", "warning", "danger", "accent", "subtle"] as const;
    for (const tone of tones) {
      const { unmount } = render(
        <Pill data-testid="pill" tone={tone}>
          {tone}
        </Pill>
      );
      const expected = `tone${tone[0].toUpperCase()}${tone.slice(1)}`;
      expect(screen.getByTestId("pill").className).toMatch(new RegExp(expected));
      unmount();
    }
  });

  it("applies square shape", () => {
    render(
      <Pill data-testid="pill" shape="square">
        x
      </Pill>
    );
    expect(screen.getByTestId("pill").className).toMatch(/shapeSquare/);
  });

  it("applies md size", () => {
    render(
      <Pill data-testid="pill" size="md">
        x
      </Pill>
    );
    expect(screen.getByTestId("pill").className).toMatch(/sizeMd/);
  });

  it("omits uppercase class when uppercase is false", () => {
    render(
      <Pill data-testid="pill" uppercase={false}>
        x
      </Pill>
    );
    expect(screen.getByTestId("pill").className).not.toMatch(/uppercase/);
  });
});
