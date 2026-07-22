import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HoverPreview from "./HoverPreview";

function touchMatchMedia(query: string): MediaQueryList {
  return {
    matches: query === "(hover: none)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

describe("HoverPreview", () => {
  afterEach(() => vi.restoreAllMocks());

  it("contains focus when a touch preview has only text", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(touchMatchMedia);
    render(
      <HoverPreview anchor="auto" onClose={vi.fn()}>
        <p>Text-only preview</p>
      </HoverPreview>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Preview" });
    expect(dialog).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(dialog).toHaveFocus());

    const notPrevented = fireEvent.keyDown(document, { key: "Tab" });
    expect(notPrevented).toBe(false);
    expect(dialog).toHaveFocus();
  });
});
