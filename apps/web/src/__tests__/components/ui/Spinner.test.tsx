import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Spinner from "@/components/ui/Spinner";

describe("Spinner", () => {
  it("renders with default md size and status role", () => {
    render(<Spinner />);
    const el = screen.getByRole("status", { name: "Loading" });
    expect(el.className).toMatch(/sizeMd/);
  });

  it("applies sm size", () => {
    render(<Spinner size="sm" />);
    expect(
      screen.getByRole("status", { name: "Loading" }).className
    ).toMatch(/sizeSm/);
  });

  it("applies lg size", () => {
    render(<Spinner size="lg" />);
    expect(
      screen.getByRole("status", { name: "Loading" }).className
    ).toMatch(/sizeLg/);
  });
});
