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

  it("grows through the row cap, scrolls above it, and shrinks again", () => {
    const maxRows = 3;
    const layoutStyle = {
      lineHeight: "20px",
      paddingTop: "4px",
      paddingBottom: "6px",
      borderTop: "2px solid currentColor",
      borderBottom: "3px solid currentColor",
      width: "240px",
    };
    const { rerender } = render(
      <Textarea
        autoGrow
        minRows={2}
        maxRows={maxRows}
        value={"one\ntwo"}
        readOnly
        aria-label="draft"
        style={layoutStyle}
      />
    );
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("draft");
    const style = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const verticalPadding =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    const verticalBorder =
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    const maxVisibleScrollArea = lineHeight * maxRows + verticalPadding;
    const expectedCappedBorderBox = maxVisibleScrollArea + verticalBorder;
    const twoRowHeight = textarea.getBoundingClientRect().height;

    expect(getComputedStyle(textarea).overflowY).toBe("hidden");
    rerender(
      <Textarea
        autoGrow
        minRows={2}
        maxRows={maxRows}
        value={"one\ntwo\nthree"}
        readOnly
        aria-label="draft"
        style={layoutStyle}
      />
    );

    const cappedHeight = textarea.getBoundingClientRect().height;
    expect(cappedHeight).toBeGreaterThan(twoRowHeight);
    expect(textarea.clientHeight).toBeCloseTo(maxVisibleScrollArea);
    expect(cappedHeight).toBeCloseTo(expectedCappedBorderBox);
    expect(getComputedStyle(textarea).overflowY).toBe("hidden");

    rerender(
      <Textarea
        autoGrow
        minRows={2}
        maxRows={maxRows}
        value={"one\ntwo\nthree\nfour\nfive\nsix"}
        readOnly
        aria-label="draft"
        style={layoutStyle}
      />
    );

    expect(textarea.getBoundingClientRect().height).toBeCloseTo(cappedHeight);
    expect(textarea.scrollHeight).toBeGreaterThan(maxVisibleScrollArea);
    expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
    expect(getComputedStyle(textarea).overflowY).toBe("auto");

    rerender(
      <Textarea
        autoGrow
        minRows={2}
        maxRows={maxRows}
        value="short"
        readOnly
        aria-label="draft"
        style={layoutStyle}
      />
    );

    expect(textarea.getBoundingClientRect().height).toBeLessThan(cappedHeight);
    expect(textarea.scrollHeight).toBeLessThanOrEqual(textarea.clientHeight);
    expect(getComputedStyle(textarea).overflowY).toBe("hidden");
  });
});
