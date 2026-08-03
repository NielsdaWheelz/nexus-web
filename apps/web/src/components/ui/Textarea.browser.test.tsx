import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import Textarea from "./Textarea";

it("grows to its real layout cap, scrolls above it, and shrinks again", () => {
  const layout = {
    lineHeight: "20px",
    paddingTop: "4px",
    paddingBottom: "6px",
    borderTop: "2px solid currentColor",
    borderBottom: "3px solid currentColor",
    width: "240px",
  };
  const view = render(
    <Textarea
      autoGrow
      minRows={2}
      maxRows={3}
      value={"one\ntwo"}
      readOnly
      aria-label="Draft"
      style={layout}
    />,
  );
  const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Draft",
  });
  const twoRows = textarea.getBoundingClientRect().height;

  view.rerender(
    <Textarea
      autoGrow
      minRows={2}
      maxRows={3}
      value={"one\ntwo\nthree"}
      readOnly
      aria-label="Draft"
      style={layout}
    />,
  );
  const cap = textarea.getBoundingClientRect().height;
  expect(cap).toBeGreaterThan(twoRows);
  expect(getComputedStyle(textarea).overflowY).toBe("hidden");

  view.rerender(
    <Textarea
      autoGrow
      minRows={2}
      maxRows={3}
      value={"one\ntwo\nthree\nfour\nfive\nsix"}
      readOnly
      aria-label="Draft"
      style={layout}
    />,
  );
  expect(textarea.getBoundingClientRect().height).toBeCloseTo(cap);
  expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
  expect(getComputedStyle(textarea).overflowY).toBe("auto");

  view.rerender(
    <Textarea
      autoGrow
      minRows={2}
      maxRows={3}
      value="short"
      readOnly
      aria-label="Draft"
      style={layout}
    />,
  );
  expect(textarea.getBoundingClientRect().height).toBeLessThan(cap);
  expect(getComputedStyle(textarea).overflowY).toBe("hidden");
});
