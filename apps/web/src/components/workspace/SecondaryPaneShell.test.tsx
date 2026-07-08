import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";

const publication = {
  groupId: "reader-tools" as const,
  defaultSurfaceId: "reader-evidence" as const,
  surfaces: [
    { id: "reader-contents" as const, body: <div>Contents body</div> },
    { id: "reader-evidence" as const, body: <div>Evidence body</div> },
  ],
};

const state = {
  groupId: "reader-tools" as const,
  activeSurfaceId: "reader-contents" as const,
  widthPx: 360,
  visibility: "visible" as const,
};

describe("SecondaryPaneShell", () => {
  it("links tabs to their own panel ids", () => {
    render(
      <SecondaryPaneShell
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
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      contentsTab.id,
    );
  });

  it("switches surfaces and resizes by secondary pane id", () => {
    const onActiveSurfaceChange = vi.fn();
    const onResize = vi.fn();
    render(
      <SecondaryPaneShell
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
      "reader-evidence",
    );

    const resizeHandle = screen.getByRole("separator", { name: "Resize Contents" });
    expect(resizeHandle).toHaveAttribute("aria-controls");
    expect(resizeHandle).toHaveAttribute("aria-orientation", "vertical");
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith("secondary-1", 376);
  });
});
