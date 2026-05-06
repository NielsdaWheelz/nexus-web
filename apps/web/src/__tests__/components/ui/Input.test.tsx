import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Input from "@/components/ui/Input";

describe("Input", () => {
  it("renders with placeholder", () => {
    render(<Input placeholder="Search" />);
    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
  });

  it("applies different className per variant", () => {
    const { rerender } = render(<Input variant="default" aria-label="i" />);
    const def = screen.getByLabelText("i").className;

    rerender(<Input variant="bare" aria-label="i" />);
    const bare = screen.getByLabelText("i").className;

    expect(def).not.toBe(bare);
  });

  it("applies different className per size", () => {
    const { rerender } = render(<Input size="sm" aria-label="i" />);
    const sm = screen.getByLabelText("i").className;

    rerender(<Input size="md" aria-label="i" />);
    const md = screen.getByLabelText("i").className;

    rerender(<Input size="lg" aria-label="i" />);
    const lg = screen.getByLabelText("i").className;

    expect(new Set([sm, md, lg]).size).toBe(3);
  });

  it("reflects disabled state in DOM", () => {
    render(<Input disabled aria-label="x" />);
    expect(screen.getByLabelText("x")).toBeDisabled();
  });

  it("accepts text input from the user", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="name" />);
    const input = screen.getByLabelText<HTMLInputElement>("name");
    await user.type(input, "hello");
    expect(input.value).toBe("hello");
  });

  it("receives focus via keyboard navigation", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="focus" />);
    await user.tab();
    expect(screen.getByLabelText("focus")).toHaveFocus();
  });
});
