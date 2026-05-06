import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Textarea from "@/components/ui/Textarea";

describe("Textarea", () => {
  it("renders with placeholder", () => {
    render(<Textarea placeholder="Notes" />);
    expect(screen.getByPlaceholderText("Notes")).toBeInTheDocument();
  });

  it("applies different className per variant", () => {
    const { rerender } = render(<Textarea variant="default" aria-label="t" />);
    const def = screen.getByLabelText("t").className;

    rerender(<Textarea variant="bare" aria-label="t" />);
    const bare = screen.getByLabelText("t").className;

    expect(def).not.toBe(bare);
  });

  it("applies different className per size", () => {
    const { rerender } = render(<Textarea size="sm" aria-label="t" />);
    const sm = screen.getByLabelText("t").className;

    rerender(<Textarea size="md" aria-label="t" />);
    const md = screen.getByLabelText("t").className;

    rerender(<Textarea size="lg" aria-label="t" />);
    const lg = screen.getByLabelText("t").className;

    expect(new Set([sm, md, lg]).size).toBe(3);
  });

  it("reflects disabled state in DOM", () => {
    render(<Textarea disabled aria-label="x" />);
    expect(screen.getByLabelText("x")).toBeDisabled();
  });

  it("accepts text input from the user", async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="msg" />);
    const ta = screen.getByLabelText<HTMLTextAreaElement>("msg");
    await user.type(ta, "hello world");
    expect(ta.value).toBe("hello world");
  });

  it("receives focus via keyboard navigation", async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="focus" />);
    await user.tab();
    expect(screen.getByLabelText("focus")).toHaveFocus();
  });

  it("uses minRows for default rows attribute", () => {
    render(<Textarea minRows={5} aria-label="r" />);
    expect(screen.getByLabelText("r")).toHaveAttribute("rows", "5");
  });
});
