import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";

const publication = {
  groupId: "reader-tools" as const,
  defaultSurfaceId: "reader-highlights" as const,
  surfaces: [
    { id: "reader-highlights" as const, body: <div>Highlights body</div> },
    { id: "reader-resource-chat" as const, body: <div>Chat body</div> },
    { id: "reader-contents" as const, body: <div>Contents body</div> },
  ],
};

const state = {
  groupId: "reader-tools" as const,
  activeSurfaceId: "reader-highlights" as const,
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

    const highlightsTab = screen.getByRole("tab", { name: "Highlights" });
    const chatTab = screen.getByRole("tab", { name: "Chat" });
    expect(screen.getByRole("tab", { name: "Contents" })).toBeInTheDocument();
    expect(highlightsTab.id).not.toBe(chatTab.id);
    expect(highlightsTab.getAttribute("aria-controls")).not.toBe(
      chatTab.getAttribute("aria-controls"),
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      highlightsTab.id,
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

    fireEvent.keyDown(screen.getByRole("tab", { name: "Highlights" }), {
      key: "ArrowRight",
    });
    expect(onActiveSurfaceChange).toHaveBeenCalledWith(
      "secondary-1",
      "reader-resource-chat",
    );

    const resizeHandle = screen.getByRole("separator", { name: "Resize Highlights" });
    expect(resizeHandle).toHaveAttribute("aria-controls");
    expect(resizeHandle).toHaveAttribute("aria-orientation", "vertical");
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith("secondary-1", 376);
  });
});
