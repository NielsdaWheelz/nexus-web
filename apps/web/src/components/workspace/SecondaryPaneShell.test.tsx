import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";

const publication = {
  groupId: "resource-inspector" as const,
  defaultSurfaceId: "resource-evidence" as const,
  surfaces: [
    { id: "resource-contents" as const, body: <div>Contents body</div> },
    { id: "resource-evidence" as const, body: <div>Evidence body</div> },
  ],
};

const state = {
  groupId: "resource-inspector" as const,
  activeSurfaceId: "resource-contents" as const,
  widthPx: 360,
  visibility: "visible" as const,
};

const transientSurface = {
  id: "resource-search" as const,
  body: <div>Search matches</div>,
};

describe("SecondaryPaneShell", () => {
  it("links tabs to their own panel ids", () => {
    render(
      <SecondaryPaneShell
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        publication={publication}
        state={state}
        sizing={{
          widthPx: 360,
          minWidthPx: 280,
          maxWidthPx: 720,
          storedWidthCorrectionPx: null,
        }}
        onActiveSurfaceChange={vi.fn()}
        onClose={vi.fn()}
        onResize={vi.fn()}
      />,
    );

    const contentsTab = screen.getByRole("tab", { name: "Contents" });
    const evidenceTab = screen.getByRole("tab", { name: "Evidence" });
    expect(contentsTab).toBeInTheDocument();
    expect(evidenceTab).toBeInTheDocument();
    expect(contentsTab.id).not.toBe(evidenceTab.id);
    expect(contentsTab.getAttribute("aria-controls")).not.toBe(
      evidenceTab.getAttribute("aria-controls"),
    );
    const contentsPanel = screen.getByRole("tabpanel", { name: "Contents" });
    const evidencePanel = screen
      .getAllByRole("tabpanel", { hidden: true })
      .find((panel) => panel.id === evidenceTab.getAttribute("aria-controls"));
    expect(evidencePanel).toBeDefined();
    expect(contentsPanel.id).toBe(contentsTab.getAttribute("aria-controls"));
    expect(contentsPanel).not.toHaveAttribute("hidden");
    expect(evidencePanel!).toHaveAttribute("hidden");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      contentsTab.id,
    );
    expect(screen.getByRole("complementary", { name: "Contents" })).toHaveAttribute(
      "id",
      "pane-pane-1-secondary-resource-inspector",
    );
  });

  it("switches surfaces and resizes by secondary pane id", () => {
    const onActiveSurfaceChange = vi.fn();
    const onResize = vi.fn();
    render(
      <SecondaryPaneShell
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        publication={publication}
        state={state}
        sizing={{
          widthPx: 360,
          minWidthPx: 280,
          maxWidthPx: 720,
          storedWidthCorrectionPx: null,
        }}
        onActiveSurfaceChange={onActiveSurfaceChange}
        onClose={vi.fn()}
        onResize={onResize}
      />,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Contents" }), {
      key: "ArrowRight",
    });
    expect(onActiveSurfaceChange).toHaveBeenCalledWith(
      "secondary-1",
      "resource-evidence",
    );

    const resizeHandle = screen.getByRole("separator", { name: "Resize Contents" });
    expect(resizeHandle).toHaveAttribute("aria-controls");
    expect(resizeHandle).toHaveAttribute("aria-orientation", "vertical");
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith("secondary-1", 376);
  });

  it("renders Search results as the temporary active tab and selects durable tabs normally", () => {
    const onActiveSurfaceChange = vi.fn();
    const onSelectDurableFromTransient = vi.fn();
    const onCloseTransient = vi.fn();
    const onClose = vi.fn();
    render(
      <SecondaryPaneShell
        primaryPaneId="pane-1"
        secondaryPaneId="secondary-1"
        publication={{ ...publication, transientSurfaces: [transientSurface] }}
        state={state}
        transientSurface={transientSurface}
        sizing={{
          widthPx: 360,
          minWidthPx: 280,
          maxWidthPx: 720,
          storedWidthCorrectionPx: null,
        }}
        onActiveSurfaceChange={onActiveSurfaceChange}
        onSelectDurableFromTransient={onSelectDurableFromTransient}
        onClose={onClose}
        onCloseTransient={onCloseTransient}
        onResize={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Search results" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Search matches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(onSelectDurableFromTransient).toHaveBeenCalledWith(
      "secondary-1",
      "resource-evidence",
    );
    expect(onActiveSurfaceChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Search results" }), {
      key: "Escape",
    });
    expect(onCloseTransient).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Close Search results" }),
    );
    expect(onCloseTransient).toHaveBeenCalledTimes(2);
  });

  it("hosts a transient-only route without a durable tab strip", () => {
    render(
      <SecondaryPaneShell
        primaryPaneId="pane-1"
        secondaryPaneId="pane-1-transient"
        publication={{
          groupId: "resource-inspector",
          surfaces: [],
          defaultSurfaceId: null,
          transientSurfaces: [transientSurface],
        }}
        state={null}
        transientSurface={transientSurface}
        sizing={{
          widthPx: 360,
          minWidthPx: 280,
          maxWidthPx: 720,
          storedWidthCorrectionPx: null,
        }}
        onActiveSurfaceChange={vi.fn()}
        onSelectDurableFromTransient={vi.fn()}
        onClose={vi.fn()}
        onCloseTransient={vi.fn()}
        onResize={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Search results")).toBeInTheDocument();
    expect(screen.getByText("Search matches")).toBeInTheDocument();
  });
});
