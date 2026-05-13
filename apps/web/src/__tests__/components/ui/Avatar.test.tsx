import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Avatar from "@/components/ui/Avatar";

describe("Avatar", () => {
  it("renders an image when src is provided", () => {
    render(
      <Avatar
        data-testid="avatar"
        src="https://example.com/a.png"
        alt="Alice"
      />
    );
    const img = screen.getByAltText("Alice");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://example.com/a.png");
  });

  it("renders initials when no src is provided", () => {
    render(
      <Avatar data-testid="avatar" initials="NB" seed="alice@example.com" />
    );
    const el = screen.getByTestId("avatar");
    expect(el).toHaveTextContent("NB");
  });

  it("applies each size class", () => {
    const { rerender } = render(
      <Avatar data-testid="avatar" size="sm" initials="A" />
    );
    expect(screen.getByTestId("avatar").className).toMatch(/sizeSm/);

    rerender(<Avatar data-testid="avatar" size="md" initials="A" />);
    expect(screen.getByTestId("avatar").className).toMatch(/sizeMd/);

    rerender(<Avatar data-testid="avatar" size="lg" initials="A" />);
    expect(screen.getByTestId("avatar").className).toMatch(/sizeLg/);
  });

  it("derives a stable color from the same seed", () => {
    const { rerender } = render(
      <Avatar data-testid="avatar-a" initials="A" seed="repeat-seed" />
    );
    const first = screen.getByText("A").getAttribute("style") ?? "";

    rerender(<Avatar data-testid="avatar-b" initials="A" seed="repeat-seed" />);
    const second = screen.getByText("A").getAttribute("style") ?? "";

    expect(first).toBe(second);
    expect(first).toMatch(/background-color/);
  });

  it("derives different colors from different seeds", () => {
    const { rerender } = render(
      <Avatar initials="A" seed="seed-one" />
    );
    const first = screen.getByText("A").getAttribute("style") ?? "";

    rerender(<Avatar initials="A" seed="seed-two-different" />);
    const second = screen.getByText("A").getAttribute("style") ?? "";

    expect(first).not.toBe(second);
  });
});
