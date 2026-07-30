import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  getQuickAction,
  SWITCHBOARD_QUICK_ACTION_IDS,
} from "@/lib/nexus/quickActions";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import { SWITCHBOARD_PLACES } from "@/lib/switchboard/places";
import SwitchboardRoot from "./SwitchboardRoot";

function renderRoot(overrides?: {
  recentlyClosed?: Array<{ id: string; label: string; metadata: string }>;
}) {
  const onFind = vi.fn();
  const onClosePane = vi.fn();
  render(
    <SwitchboardRoot
      places={SWITCHBOARD_PLACES}
      quickActions={SWITCHBOARD_QUICK_ACTION_IDS.map(getQuickAction)}
      panes={[
        {
          id: "pane-a",
          label: "The Dispossessed",
          metadata: "Active tab",
          current: true,
          activationRouteId:
            resolveWorkspaceActivationRouteId("/media/the-dispossessed"),
        },
        {
          id: "pane-b",
          label: "Notes",
          metadata: "Minimized",
          current: false,
          activationRouteId: resolveWorkspaceActivationRouteId("/notes"),
        },
      ]}
      recentlyClosed={overrides?.recentlyClosed ?? []}
      accountMenu={<button type="button">Account</button>}
      onDone={() => {}}
      onFind={onFind}
      onPlace={() => {}}
      onQuickAction={() => {}}
      onOpenPane={() => {}}
      onClosePane={onClosePane}
      onRestorePane={() => {}}
    />,
  );
  return { onFind, onClosePane };
}

describe("SwitchboardRoot", () => {
  it("renders the fixed high-signal hierarchy without focusing Find", () => {
    renderRoot();
    expect(screen.getByRole("heading", { name: "Nexus" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Places" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Quick" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Open" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Recently closed" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Find anything…" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Find anything…" }),
    ).not.toHaveFocus();
    expect(screen.getByTestId("switchboard-root-scroll")).not.toContainElement(
      screen.getByRole("button", { name: "Find anything…" }),
    );
  });

  it("shows every locked Place and Quick action", () => {
    renderRoot();
    for (const label of [
      "Lectern",
      "Libraries",
      "Browse",
      "Podcasts",
      "Chats",
      "Notes",
      "Note",
      "Page",
      "Chat",
      "Library",
      "Import",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
  });

  it("enters Find only from the anchored action and closes a pane without leaving Root", () => {
    const { onFind, onClosePane } = renderRoot();
    fireEvent.click(screen.getByRole("button", { name: "Find anything…" }));
    expect(onFind).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Notes" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Notes" }));
    expect(onClosePane).toHaveBeenCalledWith("pane-b");
    expect(screen.getByRole("heading", { name: "Nexus" })).toBeVisible();
  });

  it("renders Recently closed only when snapshots exist", () => {
    renderRoot({
      recentlyClosed: [
        { id: "closed-a", label: "Search", metadata: "Closed tab" },
      ],
    });
    expect(
      screen.getByRole("heading", { name: "Recently closed" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Search/ })).toBeVisible();
  });

  it("moves focus to the next open row after closing from the row menu", async () => {
    function CloseHarness() {
      const [panes, setPanes] = useState([
        {
          id: "pane-a",
          label: "The Dispossessed",
          metadata: "Active tab",
          current: true,
          activationRouteId:
            resolveWorkspaceActivationRouteId("/media/the-dispossessed"),
        },
        {
          id: "pane-b",
          label: "Notes",
          metadata: "Open tab",
          current: false,
          activationRouteId: resolveWorkspaceActivationRouteId("/notes"),
        },
      ]);
      return (
        <SwitchboardRoot
          places={SWITCHBOARD_PLACES}
          quickActions={SWITCHBOARD_QUICK_ACTION_IDS.map(getQuickAction)}
          panes={panes}
          recentlyClosed={[]}
          accountMenu={<button type="button">Account</button>}
          onDone={() => {}}
          onFind={() => {}}
          onPlace={() => {}}
          onQuickAction={() => {}}
          onOpenPane={() => {}}
          onClosePane={(paneId) =>
            setPanes((current) =>
              current.filter((pane) => pane.id !== paneId),
            )
          }
          onRestorePane={() => {}}
        />
      );
    }

    render(<CloseHarness />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Actions for The Dispossessed",
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Close The Dispossessed",
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Notes Open tab/ }),
      ).toHaveFocus(),
    );
  });
});
