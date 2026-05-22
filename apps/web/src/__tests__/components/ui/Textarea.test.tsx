import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Textarea from "@/components/ui/Textarea";

describe("Textarea", () => {
  it("renders with placeholder", () => {
    render(<Textarea placeholder="Notes" />);
    expect(screen.getByPlaceholderText("Notes")).toBeInTheDocument();
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
