import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DesktopNexusRow from "./DesktopNexusRow";
import type { DesktopNexusController, DesktopNexusEntry } from "./types";

const entry: DesktopNexusEntry = {
  key: "resource:alpha",
  label: "Alpha",
  typeLabel: "Highlight",
  metadata: "A book",
  excerpt: "A matched passage",
  open: true,
  icon: null,
  hasSecondaryActions: true,
};

function controller(): DesktopNexusController {
  return {
    open: true,
    page: { kind: "Find" },
    query: "alpha",
    entries: [entry],
    activeEntryKey: entry.key,
    failures: new Set(),
    busy: false,
    focusKey: "Find",
    setQuery: vi.fn(), setActiveEntry: vi.fn(),
    selectEntry: vi.fn(), openActions: vi.fn(),
    runAction: vi.fn(), retry: vi.fn(), back: vi.fn(),
    escape: vi.fn(), shouldSuppressReturnFocusOnClose: () => false,
  };
}

describe("DesktopNexusRow", () => {
  it("has one option activation with only schema-earned content", () => {
    const value = controller();
    render(<DesktopNexusRow entry={entry} selected controller={value} />);
    const option = screen.getByRole("option", { name: /Alpha\. Highlight · A book · Open\. A matched passage/ });

    expect(within(option).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(option);
    fireEvent.click(option, { shiftKey: true });

    expect(value.selectEntry).toHaveBeenNthCalledWith(
      1,
      entry.key,
      "Follow",
      "Pointer",
    );
    expect(value.selectEntry).toHaveBeenNthCalledWith(
      2,
      entry.key,
      "Fork",
      "Pointer",
    );
  });

  it("renders a static teaching entry's current keybinding as a hint", () => {
    const teaching = {
      ...entry,
      key: "PaneSearch",
      label: "Search this pane",
      shortcutHint: "⌘F",
      typeLabel: "Command",
      metadata: undefined,
      excerpt: undefined,
      open: undefined,
      hasSecondaryActions: false,
    };

    render(
      <DesktopNexusRow
        entry={teaching}
        selected
        controller={controller()}
      />,
    );

    const option = screen.getByRole("option", {
      name: "Search this pane. ⌘F. Command",
    });
    expect(within(option).getByText("⌘F")).toHaveProperty("tagName", "KBD");
  });

  it("renders matched excerpt segments as escaped text with semantic emphasis", () => {
    const segmented = {
      ...entry,
      excerpt: undefined,
      excerptSegments: [
        { text: "A ", emphasized: false },
        { text: "<matched>", emphasized: true },
        { text: " passage", emphasized: false },
      ],
    };
    render(<DesktopNexusRow entry={segmented} selected controller={controller()} />);

    expect(screen.getByText("<matched>")).toHaveProperty("tagName", "MARK");
    expect(screen.queryByText("<matched>", { selector: "script" })).toBeNull();
  });
});
