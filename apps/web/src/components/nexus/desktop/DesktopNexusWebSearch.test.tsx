import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DesktopNexusWebSearch from "./DesktopNexusWebSearch";
import type { DesktopNexusController } from "./types";

function controller(): DesktopNexusController {
  return {
    open: true,
    page: {
      kind: "WebSearch",
      query: "architecture",
      status: "Ready",
      results: [{ id: "web:one", title: "Architecture", url: "https://example.com", source: "example.com", excerpt: "A useful result." }],
    },
    query: "architecture",
    entries: [],
    activeEntryKey: null,
    activeWebResultId: "web:one",
    failures: new Set(), busy: false, focusKey: "WebSearch",
    setQuery: vi.fn(), setWebQuery: vi.fn(), setActiveEntry: vi.fn(),
    setActiveWebResult: vi.fn(), selectEntry: vi.fn(), openActions: vi.fn(),
    runAction: vi.fn(), selectWebResult: vi.fn(), retry: vi.fn(), back: vi.fn(),
    escape: vi.fn(), shouldSuppressReturnFocusOnClose: () => false,
  };
}

describe("DesktopNexusWebSearch", () => {
  it("keeps focus on its combobox and gives Web imports the normal Follow/Fork keys", () => {
    const value = controller();
    render(<DesktopNexusWebSearch controller={value} />);
    const input = screen.getByRole("combobox", { name: "Search the web" });

    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(input).toHaveFocus();
    expect(value.selectWebResult).toHaveBeenNthCalledWith(
      1,
      "web:one",
      "Follow",
      "Keyboard",
    );
    expect(value.selectWebResult).toHaveBeenNthCalledWith(
      2,
      "web:one",
      "Fork",
      "Keyboard",
    );
  });
});
