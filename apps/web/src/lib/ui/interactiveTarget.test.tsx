import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isInteractiveTarget } from "@/lib/ui/interactiveTarget";

describe("isInteractiveTarget", () => {
  it("recognizes native, ARIA, editable, and focusable ancestors", () => {
    render(
      <>
        <button type="button">
          <span>Native child</span>
        </button>
        <iframe title="Embedded content" />
        <div role="slider" tabIndex={0} aria-valuenow={1}>
          <span>ARIA child</span>
        </div>
        <div contentEditable suppressContentEditableWarning>
          <span>Editable child</span>
        </div>
        <div tabIndex={0}>
          <span>Focusable child</span>
        </div>
      </>,
    );

    expect(isInteractiveTarget(screen.getByText("Native child"))).toBe(true);
    expect(isInteractiveTarget(screen.getByTitle("Embedded content"))).toBe(
      true,
    );
    expect(isInteractiveTarget(screen.getByText("ARIA child"))).toBe(true);
    expect(isInteractiveTarget(screen.getByText("Editable child"))).toBe(true);
    expect(isInteractiveTarget(screen.getByText("Focusable child"))).toBe(true);
  });

  it("rejects plain content and non-elements", () => {
    render(<p>Reading canvas</p>);

    expect(isInteractiveTarget(screen.getByText("Reading canvas"))).toBe(false);
    expect(isInteractiveTarget(document.createTextNode("text"))).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });

  it("stops at an exclusive focusable boundary", () => {
    render(
      <div data-testid="scrollport" tabIndex={0}>
        <span>Blank descendant</span>
        <button type="button">
          <span>Interactive descendant</span>
        </button>
      </div>,
    );
    const boundary = screen.getByTestId("scrollport");

    expect(
      isInteractiveTarget(screen.getByText("Blank descendant"), boundary),
    ).toBe(false);
    expect(
      isInteractiveTarget(
        screen.getByText("Interactive descendant"),
        boundary,
      ),
    ).toBe(true);
  });
});
