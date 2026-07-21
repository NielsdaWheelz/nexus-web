import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";

type PaneItem = {
  paneId: string;
  href: string;
  label: string;
  labelState: "resolved" | "pending";
  isActive: boolean;
  isInView: boolean;
  visibility: "visible" | "minimized";
  canMinimize: boolean;
};

function paneActivator(label: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${label}\\b`) });
}

function CloseHarness() {
  const [items, setItems] = useState<PaneItem[]>([
    {
      paneId: "pane-a",
      href: "/libraries",
      label: "Libraries",
      labelState: "resolved",
      isActive: false,
      isInView: false,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-b",
      href: "/search",
      label: "Search",
      labelState: "resolved",
      isActive: true,
      isInView: false,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-c",
      href: "/media/m1",
      label: "Media",
      labelState: "resolved",
      isActive: false,
      isInView: false,
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
      href: "/libraries",
      label: "Libraries",
      labelState: "resolved",
      isActive: false,
      isInView: false,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-b",
      href: "/search",
      label: "Search",
      labelState: "resolved",
      isActive: true,
      isInView: false,
      visibility: "visible",
      canMinimize: true,
    },
    {
      paneId: "pane-c",
      href: "/media/m1",
      label: "Media",
      labelState: "resolved",
      isActive: false,
      isInView: false,
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
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            href: "/libraries",
            label: "Libraries",
            labelState: "resolved",
            isActive: true,
            isInView: false,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-b",
            href: "/search",
            label: "Search",
            labelState: "resolved",
            isActive: false,
            isInView: false,
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
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toHaveAttribute("aria-selected");
      expect(button).not.toHaveAttribute("aria-controls");
    }
    expect(paneActivator("Libraries")).toHaveAttribute("aria-current", "page");
    expect(paneActivator("Search")).toHaveAccessibleName(/Minimized\. Restore\./);
  });

  it("roves focus across pane activators without activating panes", async () => {
    const user = userEvent.setup();
    const onActivatePane = vi.fn();
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            href: "/libraries",
            label: "Libraries",
            labelState: "resolved",
            isActive: false,
            isInView: false,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-b",
            href: "/search",
            label: "Search",
            labelState: "resolved",
            isActive: true,
            isInView: false,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-c",
            href: "/media/m1",
            label: "Media",
            labelState: "resolved",
            isActive: false,
            isInView: false,
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

    paneActivator("Search").focus();
    await user.keyboard("{ArrowRight}");
    expect(paneActivator("Media")).toHaveFocus();

    await user.keyboard("{Home}");
    expect(paneActivator("Libraries")).toHaveFocus();

    await user.keyboard("{End}");
    expect(paneActivator("Media")).toHaveFocus();
    expect(onActivatePane).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onActivatePane).toHaveBeenCalledWith("pane-c");
  });

  it("activates visible panes and restores minimized panes from pane activators", async () => {
    const user = userEvent.setup();
    const onActivatePane = vi.fn();
    const onRestorePane = vi.fn();
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            href: "/libraries",
            label: "Libraries",
            labelState: "resolved",
            isActive: true,
            isInView: false,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-b",
            href: "/search",
            label: "Search",
            labelState: "resolved",
            isActive: false,
            isInView: false,
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

    await user.click(paneActivator("Libraries"));
    await user.click(paneActivator("Search"));
    await user.click(screen.getByRole("button", { name: "Restore Search" }));

    expect(onActivatePane).toHaveBeenCalledWith("pane-a");
    expect(onRestorePane).toHaveBeenNthCalledWith(1, "pane-b");
    expect(onRestorePane).toHaveBeenNthCalledWith(2, "pane-b");
  });

  it("renders minimize, restore, and close actions outside the roving sequence", async () => {
    const user = userEvent.setup();
    const onMinimizePane = vi.fn();
    const onRestorePane = vi.fn();
    const onClosePane = vi.fn();
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            href: "/libraries",
            label: "Libraries",
            labelState: "resolved",
            isActive: true,
            isInView: false,
            visibility: "visible",
            canMinimize: false,
          },
          {
            paneId: "pane-b",
            href: "/search",
            label: "Search",
            labelState: "resolved",
            isActive: false,
            isInView: false,
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

    for (const actionName of ["Minimize Libraries", "Close Libraries", "Restore Search", "Close Search"]) {
      expect(screen.getByRole("button", { name: actionName })).toHaveAttribute("tabindex", "-1");
    }

    await user.click(screen.getByRole("button", { name: "Restore Search" }));
    await user.click(screen.getByRole("button", { name: "Close Search" }));

    expect(onMinimizePane).not.toHaveBeenCalled();
    expect(onRestorePane).toHaveBeenCalledWith("pane-b");
    expect(onClosePane).toHaveBeenCalledWith("pane-b");
  });

  it("renders a skeleton for a pending pane and label text for a resolved pane", () => {
    render(
      <WorkspacePaneStrip
        items={[
          {
            paneId: "pane-a",
            href: "/libraries",
            label: "Libraries",
            labelState: "resolved",
            isActive: true,
            isInView: false,
            visibility: "visible",
            canMinimize: true,
          },
          {
            paneId: "pane-b",
            href: "/media/m1",
            label: "Storm Front",
            labelState: "pending",
            isActive: false,
            isInView: false,
            visibility: "visible",
            canMinimize: true,
          },
        ]}
        onActivatePane={() => {}}
        onMinimizePane={() => {}}
        onRestorePane={() => {}}
        onClosePane={() => {}}
      />
    );

    const pending = paneActivator("Storm Front");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAccessibleName("Storm Front");
    expect(screen.queryByText("Storm Front")).not.toBeInTheDocument();

    const resolved = paneActivator("Libraries");
    expect(resolved).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("Libraries")).toBeInTheDocument();
  });

  it("closes the focused pane activator with Delete and focuses the next survivor", async () => {
    const user = userEvent.setup();
    render(<CloseHarness />);

    paneActivator("Search").focus();
    expect(paneActivator("Search")).toHaveFocus();

    await user.keyboard("{Delete}");

    expect(screen.queryByRole("button", { name: /^Search\b/ })).not.toBeInTheDocument();
    expect(paneActivator("Media")).toHaveFocus();
    expect(paneActivator("Media")).toHaveAttribute("aria-current", "page");
  });

  it("moves focus to the next visible activator after minimizing the active pane", async () => {
    const user = userEvent.setup();
    render(<MinimizeHarness />);

    await user.click(screen.getByRole("button", { name: "Minimize Search" }));

    expect(screen.getByRole("button", { name: "Restore Search" })).toBeInTheDocument();
    expect(paneActivator("Media")).toHaveFocus();
    expect(paneActivator("Media")).toHaveAttribute("aria-current", "page");
  });
});
