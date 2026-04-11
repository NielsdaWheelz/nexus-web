import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import WorkspaceShell, { type WorkspaceShellPane } from "@/components/workspace/WorkspaceShell";

const mockIsMobileViewport = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mockIsMobileViewport.value,
}));

describe("WorkspaceShell", () => {
  const panes: WorkspaceShellPane[] = [
    {
      paneId: "pane-a",
      title: "Libraries",
      bodyMode: "standard",
      widthPx: 560,
      minWidthPx: 320,
      maxWidthPx: 1400,
      isActive: true,
      content: <div>Libraries body</div>,
    },
    {
      paneId: "pane-b",
      title: "Search",
      bodyMode: "standard",
      widthPx: 560,
      minWidthPx: 320,
      maxWidthPx: 1400,
      isActive: false,
      content: <div>Search body</div>,
    },
  ];

  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockIsMobileViewport.value = false;
    scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  });

  it("scrolls the activated pane into view when selecting its tab", async () => {
    const user = userEvent.setup();
    const onActivatePane = vi.fn();
    render(
      <WorkspaceShell
        panes={panes}
        activePaneId="pane-a"
        onActivatePane={onActivatePane}
        onClosePane={() => {}}
        onResizePane={() => {}}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Search" }));

    expect(onActivatePane).toHaveBeenCalledWith("pane-b");
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("moves focus into the activated pane chrome when selecting a tab", async () => {
    const user = userEvent.setup();
    const onActivatePane = vi.fn();
    render(
      <WorkspaceShell
        panes={panes}
        activePaneId="pane-a"
        onActivatePane={onActivatePane}
        onClosePane={() => {}}
        onResizePane={() => {}}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Search" }));

    const paneChromes = screen.getAllByTestId("pane-shell-chrome");
    expect(paneChromes[1]).toHaveFocus();
  });

  it("renders only the active pane at full viewport width on mobile", () => {
    mockIsMobileViewport.value = true;

    render(
      <WorkspaceShell
        panes={panes}
        activePaneId="pane-a"
        onActivatePane={() => {}}
        onClosePane={() => {}}
        onResizePane={() => {}}
      />
    );

    expect(screen.getByText("Libraries body")).toBeInTheDocument();
    expect(screen.queryByText("Search body")).not.toBeInTheDocument();
    const paneShell = screen.getByTestId("pane-shell-body").closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("min-width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("max-width: 100%"));
  });

  it("moves focus into newly activated pane chrome on mobile pane switch", async () => {
    mockIsMobileViewport.value = true;
    const user = userEvent.setup();

    function MobileShellHarness() {
      const [activePaneId, setActivePaneId] = useState("pane-a");
      const mobilePanes = panes.map((pane) => ({
        ...pane,
        isActive: pane.paneId === activePaneId,
      }));
      return (
        <>
          <button onClick={() => setActivePaneId("pane-b")}>Switch to Search</button>
          <WorkspaceShell
            panes={mobilePanes}
            activePaneId={activePaneId}
            onActivatePane={setActivePaneId}
            onClosePane={() => {}}
            onResizePane={() => {}}
          />
        </>
      );
    }

    render(<MobileShellHarness />);

    await user.click(screen.getByRole("button", { name: "Switch to Search" }));

    expect(screen.getByText("Search body")).toBeInTheDocument();
    expect(screen.getByTestId("pane-shell-chrome")).toHaveFocus();
  });
});
