import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import ActionMenu from "@/components/ui/ActionMenu";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

describe("ActionMenu", () => {
  it("stays open when the page scrolls", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[
          { id: "edit", label: "Edit", onSelect: vi.fn() },
          { id: "delete", label: "Delete", onSelect: vi.fn(), tone: "danger" },
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
        options={[{ id: "edit", label: "Edit", onSelect: vi.fn() }]}
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
            id: "libraries",
            label: "Libraries…",
            restoreFocusOnClose: false,
            onSelect: handleSelect,
          },
        ]}
      />
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Libraries…" }));

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Libraries…" })).not.toBeInTheDocument();
    });

    expect(handleSelect).toHaveBeenCalledWith({ triggerEl: trigger });
    expect(trigger).not.toHaveFocus();
  });

  it("routes portaled internal menu links through the pane runtime", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/settings"
        routeId="settings"
        resourceRef="settings"
        resourceKey="settings"
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
        onNavigatePane={navigatePane}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
      >
        <ActionMenu
          options={[
            {
              id: "reader-settings",
              label: "Reader settings",
              href: "/settings/reader",
            },
          ]}
        />
      </PaneRuntimeProvider>
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Reader settings" }));

    expect(navigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/settings/reader",
      { titleHint: "Reader settings" },
    );
  });

  it("opens portaled internal menu links in a sibling pane on Shift-click", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();
    const openInNewPane = vi.fn();

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/settings"
        routeId="settings"
        resourceRef="settings"
        resourceKey="settings"
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
        onNavigatePane={navigatePane}
        onReplacePane={vi.fn()}
        onOpenInNewPane={openInNewPane}
      >
        <ActionMenu
          options={[
            {
              id: "reader-settings",
              label: "Reader settings",
              href: "/settings/reader",
            },
          ]}
        />
      </PaneRuntimeProvider>
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reader settings" }), {
      shiftKey: true,
    });

    expect(openInNewPane).toHaveBeenCalledWith(
      "/settings/reader",
      "Reader settings",
      undefined,
    );
    expect(navigatePane).not.toHaveBeenCalled();
  });

  it("mounts custom render content and closes the menu via the injected closeMenu", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[
          {
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

    fireEvent.click(applyColor);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Apply color" })
      ).not.toBeInTheDocument();
    });
  });

  it("does not route disabled portaled menu links", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();
    const openInNewPane = vi.fn();

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/settings"
        routeId="settings"
        resourceRef="settings"
        resourceKey="settings"
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
        onNavigatePane={navigatePane}
        onReplacePane={vi.fn()}
        onOpenInNewPane={openInNewPane}
      >
        <ActionMenu
          options={[
            {
              id: "reader-settings",
              label: "Reader settings",
              href: "/settings/reader",
              disabled: true,
            },
          ]}
        />
      </PaneRuntimeProvider>
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reader settings" }));

    expect(navigatePane).not.toHaveBeenCalled();
    expect(openInNewPane).not.toHaveBeenCalled();
  });

});
