import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";

type PaneItem = {
  paneId: string;
  title: string;
  isActive: boolean;
  visibility: "visible" | "minimized";
  canMinimize: boolean;
};

function primaryButton(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}\\b`) });
}

function CloseHarness() {
  const [items, setItems] = useState<PaneItem[]>([
    {
      paneId: "pane-a",
      title: "Libraries",
      isActive: false,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-b",
      title: "Search",
      isActive: true,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-c",
      title: "Media",
      isActive: false,
      visibility: "visible",
      canMinimize: true,
    },
  ]);

  return (
    <WorkspacePaneStrip
      items={items}
      onActivatePane={(paneId) => {
        setItems((previous) =>
          previous.map((item) => ({ ...item, isActive: item.paneId === paneId }))
        );
      }}
      onMinimizePane={() => {}}
      onRestorePane={() => {}}
      onClosePane={(paneId) => {
        setItems((previous) => {
          const closingIndex = previous.findIndex((item) => item.paneId === paneId);
          const nextItems = previous.filter((item) => item.paneId !== paneId);
          if (nextItems.length === 0) {
            return previous;
          }
          const nextIndex = Math.min(closingIndex, nextItems.length - 1);
          return nextItems.map((item, index) => ({ ...item, isActive: index === nextIndex }));
        });
      }}
    />
  );
}

function MinimizeHarness() {
  const [items, setItems] = useState<PaneItem[]>([
    {
      paneId: "pane-a",
      title: "Libraries",
      isActive: false,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-b",
      title: "Search",
      isActive: true,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-c",
      title: "Media",
      isActive: false,
      visibility: "visible",
      canMinimize: true,
    },
  ]);

  return (
    <WorkspacePaneStrip
      items={items}
      onActivatePane={() => {}}
      onMinimizePane={(paneId) => {
        setItems((previous) =>
          previous.map((item) => {
            if (item.paneId === paneId) {
              return { ...item, isActive: false, visibility: "minimized" };
            }
            return { ...item, isActive: item.paneId === "pane-c" };
          })
        );
      }}
      onRestorePane={() => {}}
      onClosePane={() => {}}
    />
  );
}

describe("WorkspacePaneStrip", () => {
  it("renders pane switcher semantics without tab ARIA", () => {
    const { container } = render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            title: "Libraries",
            isActive: true,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-b",
            title: "Search",
            isActive: false,
            visibility: "minimized",
            canMinimize: false,
          },
        ]}
        onActivatePane={() => {}}
        onMinimizePane={() => {}}
        onRestorePane={() => {}}
        onClosePane={() => {}}
      />
    );

    expect(screen.getByRole("toolbar", { name: "Workspace panes" })).toBeInTheDocument();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.querySelector("[aria-selected]")).toBeNull();
    expect(container.querySelector("[aria-controls]")).toBeNull();
    expect(primaryButton("Libraries")).toHaveAttribute("aria-current", "true");
    expect(primaryButton("Search")).toHaveAccessibleName(/Minimized\. Restore\./);
  });

  it("roves focus across primary pane buttons without activating panes", async () => {
    const user = userEvent.setup();
    const onActivatePane = vi.fn();
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            title: "Libraries",
            isActive: false,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-b",
            title: "Search",
            isActive: true,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-c",
            title: "Media",
            isActive: false,
            visibility: "visible",
            canMinimize: true,
          },
        ]}
        onActivatePane={onActivatePane}
        onMinimizePane={() => {}}
        onRestorePane={() => {}}
        onClosePane={() => {}}
      />
    );

    primaryButton("Search").focus();
    await user.keyboard("{ArrowRight}");
    expect(primaryButton("Media")).toHaveFocus();

    await user.keyboard("{Home}");
    expect(primaryButton("Libraries")).toHaveFocus();

    await user.keyboard("{End}");
    expect(primaryButton("Media")).toHaveFocus();
    expect(onActivatePane).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onActivatePane).toHaveBeenCalledWith("pane-c");
  });

  it("activates visible panes and restores minimized panes from primary buttons", async () => {
    const user = userEvent.setup();
    const onActivatePane = vi.fn();
    const onRestorePane = vi.fn();
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            title: "Libraries",
            isActive: true,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-b",
            title: "Search",
            isActive: false,
            visibility: "minimized",
            canMinimize: false,
          },
        ]}
        onActivatePane={onActivatePane}
        onMinimizePane={() => {}}
        onRestorePane={onRestorePane}
        onClosePane={() => {}}
      />
    );

    await user.click(primaryButton("Libraries"));
    await user.click(primaryButton("Search"));
    await user.click(screen.getByRole("button", { name: "Restore Search" }));

    expect(onActivatePane).toHaveBeenCalledWith("pane-a");
    expect(onRestorePane).toHaveBeenNthCalledWith(1, "pane-b");
    expect(onRestorePane).toHaveBeenNthCalledWith(2, "pane-b");
  });

  it("renders minimize, restore, and close actions", async () => {
    const user = userEvent.setup();
    const onMinimizePane = vi.fn();
    const onRestorePane = vi.fn();
    const onClosePane = vi.fn();
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            title: "Libraries",
            isActive: true,
            visibility: "visible",
            canMinimize: false,
          },
          {
            paneId: "pane-b",
            title: "Search",
            isActive: false,
            visibility: "minimized",
            canMinimize: false,
          },
        ]}
        onActivatePane={() => {}}
        onMinimizePane={onMinimizePane}
        onRestorePane={onRestorePane}
        onClosePane={onClosePane}
      />
    );

    const minimizeLibraries = screen.getByRole("button", { name: "Minimize Libraries" });
    expect(minimizeLibraries).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Restore Search" }));
    await user.click(screen.getByRole("button", { name: "Close Search" }));

    expect(onMinimizePane).not.toHaveBeenCalled();
    expect(onRestorePane).toHaveBeenCalledWith("pane-b");
    expect(onClosePane).toHaveBeenCalledWith("pane-b");
  });

  it("closes the focused primary pane with Delete and focuses the next survivor", async () => {
    const user = userEvent.setup();
    render(<CloseHarness />);

    primaryButton("Search").focus();
    expect(primaryButton("Search")).toHaveFocus();

    await user.keyboard("{Delete}");

    expect(screen.queryByRole("button", { name: /^Search\b/ })).not.toBeInTheDocument();
    expect(primaryButton("Media")).toHaveFocus();
    expect(primaryButton("Media")).toHaveAttribute("aria-current", "true");
  });

  it("moves focus to the next visible primary button after minimizing the active pane", async () => {
    const user = userEvent.setup();
    render(<MinimizeHarness />);

    await user.click(screen.getByRole("button", { name: "Minimize Search" }));

    expect(screen.getByRole("button", { name: "Restore Search" })).toBeInTheDocument();
    expect(primaryButton("Media")).toHaveFocus();
    expect(primaryButton("Media")).toHaveAttribute("aria-current", "true");
  });
});
