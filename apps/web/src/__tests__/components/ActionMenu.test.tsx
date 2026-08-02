import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import ActionMenu from "@/components/ui/ActionMenu";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

function expectInside(inner: DOMRect, outer: DOMRect) {
  expect(inner.left).toBeGreaterThanOrEqual(outer.left);
  expect(inner.top).toBeGreaterThanOrEqual(outer.top);
  expect(inner.right).toBeLessThanOrEqual(outer.right);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
}

describe("ActionMenu", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty("--viewport-safe-top", "0px");
    document.documentElement.style.setProperty("--viewport-safe-right", "0px");
    document.documentElement.style.setProperty("--viewport-safe-bottom", "0px");
    document.documentElement.style.setProperty("--viewport-safe-left", "0px");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--viewport-safe-top");
    document.documentElement.style.removeProperty("--viewport-safe-right");
    document.documentElement.style.removeProperty("--viewport-safe-bottom");
    document.documentElement.style.removeProperty("--viewport-safe-left");
  });

  it("keeps an oversized player menu and its keyboard-selected close action inside the visual safe rectangle", async () => {
    const user = userEvent.setup();
    const root = document.documentElement;
    const safeInsets = {
      top: 11,
      right: 13,
      bottom: 17,
      left: 19,
    } as const;
    const onClosePlayer = vi.fn();
    const options: ActionDescriptor[] = [
      ...Array.from({ length: 60 }, (_, index): ActionDescriptor => ({
        kind: "command",
        id: `player-action-${index}`,
        label: `Player action ${index + 1}`,
        onSelect: vi.fn(),
      })),
      {
        kind: "command",
        id: "close-player",
        label: "Close player",
        onSelect: onClosePlayer,
      },
    ];

    for (const [edge, value] of Object.entries(safeInsets)) {
      root.style.setProperty(`--viewport-safe-${edge}`, `${value}px`);
    }

    try {
      render(
        <ActionMenu
          align="end"
          label="More player controls"
          options={options}
          placement="above"
          renderTrigger={(triggerProps) => (
            <button
              {...triggerProps}
              style={{ bottom: 0, position: "fixed", right: 0 }}
            >
              More player controls
            </button>
          )}
        />,
      );

      await user.click(
        screen.getByRole("button", { name: "More player controls" }),
      );

      const viewport = window.visualViewport;
      if (viewport === null) {
        throw new Error("This browser proof requires VisualViewport support.");
      }
      const safeRectangle = new DOMRect(
        viewport.offsetLeft + safeInsets.left,
        viewport.offsetTop + safeInsets.top,
        viewport.width - safeInsets.left - safeInsets.right,
        viewport.height - safeInsets.top - safeInsets.bottom,
      );
      const menu = screen.getByRole("menu");

      await waitFor(() => {
        expectInside(menu.getBoundingClientRect(), safeRectangle);
      });

      await waitFor(() => {
        expect(
          screen.getByRole("menuitem", { name: "Player action 1" }),
        ).toHaveFocus();
      });
      await user.keyboard("{End}");
      const closePlayer = screen.getByRole("menuitem", {
        name: "Close player",
      });

      await waitFor(() => {
        const menuRectangle = menu.getBoundingClientRect();
        const closeRectangle = closePlayer.getBoundingClientRect();
        expect(closePlayer).toHaveFocus();
        expectInside(closeRectangle, menuRectangle);
        expectInside(closeRectangle, safeRectangle);
      });

      await user.click(closePlayer);

      await waitFor(() => {
        expect(
          screen.queryByRole("menuitem", { name: "Close player" }),
        ).not.toBeInTheDocument();
      });
      expect(onClosePlayer).toHaveBeenCalledTimes(1);
    } finally {
      for (const edge of Object.keys(safeInsets)) {
        root.style.removeProperty(`--viewport-safe-${edge}`);
      }
    }
  });

  it("stays open when the page scrolls", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[
          { kind: "command", id: "edit", label: "Edit", onSelect: vi.fn() },
          { kind: "command", id: "delete", label: "Delete", onSelect: vi.fn(), tone: "danger" },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();

    window.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    });
  });

  it("closes when clicking outside the menu", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[{ kind: "command", id: "edit", label: "Edit", onSelect: vi.fn() }]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();

    await user.click(document.body);

    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Edit" })
      ).not.toBeInTheDocument();
    });
  });

  it("passes the trigger to onSelect and can skip focus restore for panel handoff", async () => {
    const user = userEvent.setup();
    const handleSelect = vi.fn();

    render(
      <ActionMenu
        options={[
          {
            kind: "command",
            id: "libraries",
            label: "Move…",
            restoreFocusOnClose: false,
            onSelect: handleSelect,
          },
        ]}
      />
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Move…" }));

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Move…" })).not.toBeInTheDocument();
    });

    expect(handleSelect).toHaveBeenCalledWith({ triggerEl: trigger });
    expect(trigger).not.toHaveFocus();
  });

  it("closes before onSelect synchronously updates a parent", async () => {
    const user = userEvent.setup();
    const menuStateObservedBySelect = vi.fn();

    function Parent() {
      const [selectionCount, setSelectionCount] = useState(0);

      return (
        <>
          <output aria-label="Selection count">{selectionCount}</output>
          <ActionMenu
            options={[
              {
                kind: "command",
                id: "select",
                label: "Select",
                onSelect: () => {
                  flushSync(() => setSelectionCount((count) => count + 1));
                  menuStateObservedBySelect(
                    screen.queryByRole("menuitem", { name: "Select" }) !== null,
                  );
                },
              },
            ]}
          />
        </>
      );
    }

    render(<Parent />);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Select" }));

    expect(screen.getByRole("status", { name: "Selection count" })).toHaveTextContent("1");
    expect(menuStateObservedBySelect).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menuitem", { name: "Select" })).not.toBeInTheDocument();
  });

  it("mounts custom render content and closes the menu via the injected closeMenu", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[
          {
            kind: "custom",
            id: "color",
            label: "Highlight color",
            render: ({ closeMenu }) => (
              <button type="button" onClick={() => closeMenu()}>
                Apply color
              </button>
            ),
          },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    const applyColor = screen.getByRole("button", { name: "Apply color" });
    expect(applyColor).toBeInTheDocument();
    await waitFor(() => {
      expect(applyColor).toHaveFocus();
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Apply color" })
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus();
    });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    const reopenedApplyColor = screen.getByRole("button", { name: "Apply color" });

    fireEvent.click(reopenedApplyColor);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Apply color" })
      ).not.toBeInTheDocument();
    });
  });

  it("keeps arrow navigation on menuitems when custom render content is present", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[
          { kind: "command", id: "quote", label: "Quote", onSelect: vi.fn() },
          {
            kind: "custom",
            id: "color",
            label: "Highlight color",
            render: () => <button type="button">Apply color</button>,
          },
          { kind: "command", id: "delete", label: "Delete", onSelect: vi.fn(), tone: "danger" },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    const quote = screen.getByRole("menuitem", { name: "Quote" });
    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    await waitFor(() => {
      expect(quote).toHaveFocus();
    });

    await user.keyboard("{ArrowDown}");
    expect(deleteItem).toHaveFocus();

    await user.keyboard("{Home}");
    expect(quote).toHaveFocus();

    await user.keyboard("{End}");
    expect(deleteItem).toHaveFocus();
  });

  it("keeps unavailable commands in keyboard navigation without activating them", async () => {
    const user = userEvent.setup();
    const handleSelect = vi.fn();

    render(
      <ActionMenu
        options={[
          {
            kind: "command",
            id: "edit",
            label: "Edit",
            onSelect: vi.fn(),
          },
          {
            kind: "command",
            id: "retry",
            label: "Retry",
            disabled: true,
            disabledReason: "A retry is already in progress.",
            onSelect: handleSelect,
          },
          {
            kind: "command",
            id: "delete",
            label: "Delete",
            onSelect: vi.fn(),
          },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    const retry = screen.getByRole("menuitem", { name: "Retry" });
    await user.keyboard("{ArrowDown}");

    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toHaveAttribute("disabled");
    expect(retry).toHaveAccessibleDescription("A retry is already in progress.");

    fireEvent.click(retry);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(handleSelect).not.toHaveBeenCalled();
    expect(retry).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("keeps unavailable links in keyboard navigation without activating them", async () => {
    const user = userEvent.setup();
    const handleSelect = vi.fn();

    render(
      <ActionMenu
        options={[
          {
            kind: "link",
            id: "reader-settings",
            label: "Reader settings",
            href: "/settings/reader",
            disabled: true,
            disabledReason: "Reader settings are still loading.",
            onSelect: handleSelect,
          },
          {
            kind: "command",
            id: "delete",
            label: "Delete",
            onSelect: vi.fn(),
          },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    const readerSettings = screen.getByRole("menuitem", {
      name: "Reader settings",
    });

    await waitFor(() => {
      expect(readerSettings).toHaveFocus();
    });
    expect(readerSettings).toHaveAttribute("aria-disabled", "true");
    expect(readerSettings).not.toHaveAttribute("href");
    expect(readerSettings).toHaveAttribute("tabindex", "-1");
    expect(readerSettings).toHaveAccessibleDescription(
      "Reader settings are still loading.",
    );

    fireEvent.click(readerSettings);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(handleSelect).not.toHaveBeenCalled();
    expect(readerSettings).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("projects toggle and disclosure state without submenu ARIA", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ActionMenu
        options={[
          {
            kind: "command",
            id: "edit-bounds",
            label: "Edit bounds",
            state: { kind: "toggle", pressed: true },
            onSelect: vi.fn(),
          },
          {
            kind: "command",
            id: "resource-inspector-companion",
            label: "Companion",
            state: {
              kind: "disclosure",
              expanded: false,
              menuLabels: {
                collapsed: "Show Companion",
                expanded: "Hide Companion",
              },
            },
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Edit bounds" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const collapsed = screen.getByRole("menuitem", { name: "Show Companion" });
    expect(collapsed).not.toHaveAttribute("aria-expanded");
    expect(collapsed).not.toHaveAttribute("aria-controls");

    rerender(
      <ActionMenu
        options={[
          {
            kind: "command",
            id: "resource-inspector-companion",
            label: "Companion",
            state: {
              kind: "disclosure",
              expanded: true,
              controls: "resource-inspector-pane-1",
              menuLabels: {
                collapsed: "Show Companion",
                expanded: "Hide Companion",
              },
            },
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    const expanded = screen.getByRole("menuitem", { name: "Hide Companion" });
    expect(expanded).not.toHaveAttribute("aria-expanded");
    expect(expanded).not.toHaveAttribute("aria-controls");
  });
});
