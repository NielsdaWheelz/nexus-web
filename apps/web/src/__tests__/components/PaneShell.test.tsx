import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PaneShell from "@/components/workspace/PaneShell";
import DocumentViewport from "@/components/workspace/DocumentViewport";

describe("PaneShell", () => {
  it("keeps chrome outside the scrollable body in standard mode", () => {
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
      >
        <div>Body content</div>
      </PaneShell>
    );

    expect(screen.getByText("Libraries")).toBeInTheDocument();
    const chrome = screen.getByTestId("pane-shell-chrome");
    const body = screen.getByTestId("pane-shell-body");
    expect(chrome).toBeInTheDocument();
    expect(body).toBeInTheDocument();
    expect(body).toHaveAttribute("data-body-mode", "standard");
    expect(body).toHaveAttribute("data-pane-content", "true");
    expect(body).toHaveStyle({
      display: "flex",
      flexDirection: "column",
      minHeight: "0",
      overflowY: "auto",
      overflowX: "hidden",
    });
  });

  it("delegates keyboard resize to the focused resize handle", () => {
    const onResizePane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={onResizePane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Libraries" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });

    expect(onResizePane).toHaveBeenCalledWith("pane-a", 576);
    expect(onResizePane).toHaveBeenCalledWith("pane-a", 544);
    expect(onResizePane).toHaveBeenCalledWith("pane-a", 320);
    expect(onResizePane).toHaveBeenCalledWith("pane-a", 1400);
  });

  it("supports pointer drag resize on desktop", () => {
    const onResizePane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={onResizePane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Libraries" });
    fireEvent.mouseDown(handle, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 760 });
    fireEvent.mouseMove(document, { clientX: 40 });
    fireEvent.mouseUp(document);

    expect(onResizePane).toHaveBeenCalledWith("pane-a", 720);
    expect(onResizePane).toHaveBeenCalledWith("pane-a", 320);
  });

  it("uses clipped outer body for document mode", () => {
    render(
      <PaneShell
        paneId="pane-doc"
        title="PDF"
        widthPx={920}
        minWidthPx={420}
        maxWidthPx={1800}
        bodyMode="document"
        onResizePane={() => {}}
      >
        <DocumentViewport>
          <div>Document body</div>
        </DocumentViewport>
      </PaneShell>
    );

    const body = screen.getByTestId("pane-shell-body");
    const viewport = screen.getByTestId("document-viewport");
    expect(body).toHaveAttribute("data-body-mode", "document");
    expect(body).toHaveAttribute("data-pane-content", "true");
    expect(body).toHaveStyle({
      display: "flex",
      flexDirection: "column",
      minHeight: "0",
      overflow: "hidden",
    });
    expect(viewport).toHaveAttribute("data-pane-content", "true");
    expect(viewport).toHaveStyle({ overflow: "auto" });
  });
});
