import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DesktopNexusResults from "./DesktopNexusResults";
import type { DesktopNexusController } from "./types";

function controller(): DesktopNexusController {
  return {
    open: true,
    page: { kind: "Find" },
    query: "reading",
    entries: [
      {
        key: "note:owner",
        label: "Reading notes",
        icon: null,
        hasSecondaryActions: true,
      },
      {
        key: "highlight:one",
        label: "A highlighted passage",
        parentKey: "note:owner",
        parentLabel: "Reading notes",
        typeLabel: "Highlight",
        icon: null,
        hasSecondaryActions: false,
      },
    ],
    activeEntryKey: "highlight:one",
    activeWebResultId: null,
    failures: new Set(),
    busy: false,
    focusKey: "Find",
    setQuery: vi.fn(),
    setWebQuery: vi.fn(),
    setActiveEntry: vi.fn(),
    setActiveWebResult: vi.fn(),
    selectEntry: vi.fn(),
    openActions: vi.fn(),
    runAction: vi.fn(),
    selectWebResult: vi.fn(),
    retry: vi.fn(),
    back: vi.fn(),
    escape: vi.fn(),
    shouldSuppressReturnFocusOnClose: () => false,
  };
}

describe("DesktopNexusResults", () => {
  it("groups an admitted deep occurrence beneath its canonical parent without nested controls", () => {
    render(<DesktopNexusResults controller={controller()} />);

    const group = screen.getByRole("group", {
      name: "Matches in Reading notes",
    });
    expect(within(group).getAllByRole("option")).toHaveLength(2);
    expect(
      within(group).getByRole("option", { name: /A highlighted passage/ }),
    ).toHaveAttribute("data-nested", "true");
    expect(within(group).queryByRole("button")).toBeNull();
    expect(within(group).queryByRole("menuitem")).toBeNull();
  });

  it("keeps an absent canonical owner as a labelled non-actionable group at the first child rank", () => {
    const value = controller();
    render(
      <DesktopNexusResults
        controller={{
          ...value,
          entries: [
            {
              key: "highlight:first",
              label: "First passage",
              parentKey: "media:book",
              parentLabel: "The book",
              icon: null,
              hasSecondaryActions: false,
            },
            {
              key: "highlight:second",
              label: "Second passage",
              parentKey: "media:book",
              parentLabel: "The book",
              icon: null,
              hasSecondaryActions: false,
            },
            {
              key: "note:after",
              label: "Later note",
              icon: null,
              hasSecondaryActions: false,
            },
          ],
        }}
      />,
    );

    const list = screen.getByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual(["First passage", "Second passage", "Later note"]);
    const group = within(list).getByRole("group", { name: "Matches in The book" });
    expect(within(group).queryByRole("button")).toBeNull();
  });

  it("does not group an entry under itself", () => {
    const value = controller();
    render(
      <DesktopNexusResults
        controller={{
          ...value,
          entries: [
            {
              key: "note:self",
              label: "Self note",
              parentKey: "note:self",
              parentLabel: "Self note",
              icon: null,
              hasSecondaryActions: false,
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("option", { name: "Self note" })).toBeVisible();
    expect(screen.queryByRole("group")).toBeNull();
  });
});
