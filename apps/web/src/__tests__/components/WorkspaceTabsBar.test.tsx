import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import WorkspaceTabsBar from "@/components/workspace/WorkspaceTabsBar";

function TabsHarness() {
  const [tabs, setTabs] = useState([
    { paneId: "pane-a", title: "Libraries", isActive: false },
    { paneId: "pane-b", title: "Search", isActive: true },
    { paneId: "pane-c", title: "Media", isActive: false },
  ]);

  return (
    <WorkspaceTabsBar
      tabs={tabs}
      onActivatePane={(paneId) => {
        setTabs((previous) =>
          previous.map((tab) => ({ ...tab, isActive: tab.paneId === paneId }))
        );
      }}
      onClosePane={(paneId) => {
        setTabs((previous) => {
          const closingIndex = previous.findIndex((tab) => tab.paneId === paneId);
          const nextTabs = previous.filter((tab) => tab.paneId !== paneId);
          if (nextTabs.length === 0) {
            return previous;
          }
          const nextIndex = Math.min(closingIndex, nextTabs.length - 1);
          return nextTabs.map((tab, index) => ({ ...tab, isActive: index === nextIndex }));
        });
      }}
      mobileSwitcherLabel="Open panes"
    />
  );
}

describe("WorkspaceTabsBar", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1200);
    window.dispatchEvent(new Event("resize"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders global tab semantics for panes", () => {
    render(
      <WorkspaceTabsBar
        tabs={[
          { paneId: "pane-a", title: "Libraries", isActive: true },
          { paneId: "pane-b", title: "Search", isActive: false },
        ]}
        onActivatePane={() => {}}
        onClosePane={() => {}}
        mobileSwitcherLabel="Open panes"
      />
    );

    expect(screen.getByRole("tablist", { name: "Workspace panes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Libraries" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Search" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("moves focus to the next surviving tab after close", async () => {
    const user = userEvent.setup();
    render(<TabsHarness />);

    const closeSearch = screen.getByRole("button", { name: "Close Search" });
    closeSearch.focus();
    expect(closeSearch).toHaveFocus();

    await user.click(closeSearch);

    expect(screen.queryByRole("tab", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Media" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Media" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("supports horizontal arrow-key tab activation", async () => {
    const user = userEvent.setup();
    render(<TabsHarness />);

    const activeTab = screen.getByRole("tab", { name: "Search" });
    activeTab.focus();
    expect(activeTab).toHaveFocus();

    await user.keyboard("{ArrowRight}");

    const mediaTab = screen.getByRole("tab", { name: "Media" });
    expect(mediaTab).toHaveAttribute("aria-selected", "true");
    expect(mediaTab).toHaveFocus();
  });

  it("renders one global switcher on mobile instead of inline tabs", () => {
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    render(
      <WorkspaceTabsBar
        tabs={[
          { paneId: "pane-a", title: "Libraries", isActive: true },
          { paneId: "pane-b", title: "Search", isActive: false },
        ]}
        onActivatePane={() => {}}
        onClosePane={() => {}}
        mobileSwitcherLabel="Open panes"
      />
    );

    expect(screen.queryByRole("tablist", { name: "Workspace panes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open panes" })).toBeInTheDocument();
  });
});
