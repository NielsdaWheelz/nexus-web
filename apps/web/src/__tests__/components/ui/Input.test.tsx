import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Input from "@/components/ui/Input";

describe("Input", () => {
  it("renders with placeholder", () => {
    render(<Input placeholder="Search" />);
    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
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
