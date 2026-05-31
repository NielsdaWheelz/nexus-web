import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import ActionMenu from "@/components/ui/ActionMenu";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import PaneRouteBoundary from "./PaneRouteBoundary";

type NavigatePane = (
  paneId: string,
  href: string,
  options?: { titleHint?: string },
) => void;

type OpenInNewPane = (
  href: string,
  titleHint?: string,
  secondarySurfaceId?: WorkspaceSecondarySurfaceId,
) => void;

function renderBoundary(input: {
  navigatePane?: NavigatePane;
  openInNewPane?: OpenInNewPane;
  disabled?: boolean;
}) {
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
      onNavigatePane={input.navigatePane ?? vi.fn<NavigatePane>()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={input.openInNewPane ?? vi.fn<OpenInNewPane>()}
    >
      <PaneRouteBoundary>
        <ActionMenu
          options={[
            {
              id: "reader-settings",
              label: "Reader settings",
              href: "/settings/reader",
              disabled: input.disabled,
            },
          ]}
        />
      </PaneRouteBoundary>
    </PaneRuntimeProvider>,
  );
}

describe("PaneRouteBoundary", () => {
  it("routes portaled menu links through the current pane", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();
    renderBoundary({ navigatePane });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Reader settings" }));

    expect(navigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/settings/reader",
      { titleHint: "Reader settings" },
    );
  });

  it("opens portaled menu links in a sibling pane on Shift-click", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();
    const openInNewPane = vi.fn();
    renderBoundary({ navigatePane, openInNewPane });

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

  it("leaves disabled portaled menu links alone", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();
    const openInNewPane = vi.fn();
    renderBoundary({ navigatePane, openInNewPane, disabled: true });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reader settings" }));

    expect(navigatePane).not.toHaveBeenCalled();
    expect(openInNewPane).not.toHaveBeenCalled();
  });
});
