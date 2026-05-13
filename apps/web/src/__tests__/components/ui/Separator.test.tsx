import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Separator from "@/components/ui/Separator";

describe("Separator", () => {
  it("renders a horizontal separator by default", () => {
    render(<Separator />);

    const separator = screen.getByRole("separator");
    expect(separator).toBeInTheDocument();
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    expect(separator.tagName.toLowerCase()).toBe("hr");
  });

  it("renders a vertical separator when orientation='vertical'", () => {
    render(<Separator orientation="vertical" />);

    const separator = screen.getByRole("separator");
    expect(separator).toBeInTheDocument();
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator.tagName.toLowerCase()).toBe("div");
  });
});
