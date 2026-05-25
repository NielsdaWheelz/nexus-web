import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PaletteMobileShell from "@/components/palette/PaletteMobileShell";
import type { PaletteCommand, PaletteView } from "@/components/palette/types";

const TestIcon = (() => <svg aria-hidden="true" />) as PaletteCommand["icon"];

const restingView: PaletteView = {
  state: "resting",
  groups: [
    {
      sectionId: "navigate",
      label: "Go to",
      commands: [
        {
          id: "nav-library",
          title: "Library",
          keywords: [],
          sectionId: "navigate",
          icon: TestIcon,
          target: { kind: "href", href: "/libraries", externalShell: false },
          source: "static",
          rank: {},
          shortcutLabel: "G then L",
        },
      ],
    },
  ],
};

function renderShell(
  overrides: {
    onClose?: () => void;
    onTrailingAction?: (command: PaletteCommand) => void;
    view?: PaletteView;
  } = {},
) {
  return render(
    <PaletteMobileShell
      query=""
      view={overrides.view ?? restingView}
      searchLoading={false}
      onQueryChange={vi.fn()}
      onSelect={vi.fn()}
      onTrailingAction={overrides.onTrailingAction ?? vi.fn()}
      onClose={overrides.onClose ?? vi.fn()}
    />,
  );
}

// The shell pushes a history marker on mount and pops it with history.back() on a UI close.
// Both touch global browser history; stub them to no-ops so one test's marker dance cannot
// leak a popstate into the next. The browser setup restores spies after cleanup() each test.
beforeEach(() => {
  vi.spyOn(history, "pushState").mockImplementation(() => {});
  vi.spyOn(history, "back").mockImplementation(() => {});
});

describe("PaletteMobileShell", () => {
  // visualViewport resizing and swipe dismissal require device-level verification.

  it("renders an open full-screen dialog", () => {
    renderShell();

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveProperty("open", true);
    expect(getComputedStyle(dialog).width).toBe(`${window.innerWidth}px`);
  });

  it("does not focus the input on open", () => {
    renderShell();

    expect(screen.getByRole("combobox", { name: /search commands/i })).not.toHaveFocus();
  });

  it("renders no shortcut hints", () => {
    renderShell();

    expect(screen.queryByText("G then L")).not.toBeInTheDocument();
  });

  it("closes when the close button is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderShell({ onClose });

    await user.click(screen.getByRole("button", { name: "Close command palette" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(history.back).toHaveBeenCalledTimes(1);
  });

  it("does not pop history during effect cleanup", () => {
    const { unmount } = renderShell();

    unmount();

    expect(history.back).not.toHaveBeenCalled();
  });

  it("closes when the browser back button fires popstate", () => {
    const onClose = vi.fn();
    renderShell({ onClose });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(history.back).not.toHaveBeenCalled();
  });

  it("invokes onTrailingAction when the inline close button is tapped", async () => {
    const user = userEvent.setup();
    const onTrailingAction = vi.fn();
    const view: PaletteView = {
      state: "resting",
      groups: [
        {
          sectionId: "open-tabs",
          label: "Open tabs",
          commands: [
            {
              id: "pane-open-1",
              title: "My Doc",
              keywords: [],
              sectionId: "open-tabs",
              icon: TestIcon,
              target: { kind: "action", actionId: "pane-open:1" },
              source: "workspace",
              rank: {},
              trailingAction: { actionId: "pane-close:1", ariaLabel: "Close My Doc" },
            },
          ],
        },
      ],
    };
    renderShell({ view, onTrailingAction });

    await user.click(screen.getByRole("button", { name: "Close My Doc" }));

    expect(onTrailingAction).toHaveBeenCalledWith(expect.objectContaining({ id: "pane-open-1" }));
  });
});
