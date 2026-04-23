import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import PaneShell, {
  usePaneChromeOverride,
  usePaneChromeScrollHandler,
  usePaneMobileChromeVisibility,
} from "@/components/workspace/PaneShell";

describe("PaneShell", () => {
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

  it("keeps mobile chrome visible while a standard-pane body scrolls", () => {
    render(
      <PaneShell
        paneId="pane-standard"
        title="Libraries"
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
        isMobile
      >
        <div style={{ height: "1200px" }}>Tall body</div>
      </PaneShell>
    );

    const body = screen.getByTestId("pane-shell-body");
    const shell = screen.getByTestId("pane-shell-root");

    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");

    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(body);

    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");
  });

  it("drives mobile document chrome visibility from the document viewport scroll", () => {
    render(
      <PaneShell
        paneId="pane-doc"
        title="PDF"
        widthPx={920}
        minWidthPx={420}
        maxWidthPx={1800}
        bodyMode="document"
        onResizePane={() => {}}
        isMobile
      >
        <WiredDocumentBody>
          <div style={{ height: "1600px" }}>Document body</div>
        </WiredDocumentBody>
      </PaneShell>
    );

    const viewport = screen.getByTestId("document-viewport");
    const shell = screen.getByTestId("pane-shell-root");

    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(viewport);
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "true");

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 0,
    });
    fireEvent.scroll(viewport);
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");
  });

  it("hides mobile document chrome after multiple small downward scroll events", () => {
    render(
      <PaneShell
        paneId="pane-doc"
        title="Reader"
        widthPx={920}
        minWidthPx={420}
        maxWidthPx={1800}
        bodyMode="document"
        onResizePane={() => {}}
        isMobile
      >
        <WiredDocumentBody>
          <div style={{ height: "1600px" }}>Document body</div>
        </WiredDocumentBody>
      </PaneShell>
    );

    const viewport = screen.getByTestId("document-viewport");
    const shell = screen.getByTestId("pane-shell-root");

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 12,
    });
    fireEvent.scroll(viewport);
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 20,
    });
    fireEvent.scroll(viewport);
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 28,
    });
    fireEvent.scroll(viewport);
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 34,
    });
    fireEvent.scroll(viewport);
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "true");
  });

  it("keeps document chrome visible while a child locks it open", () => {
    render(
      <PaneShell
        paneId="pane-doc"
        title="Reader"
        widthPx={920}
        minWidthPx={420}
        maxWidthPx={1800}
        bodyMode="document"
        onResizePane={() => {}}
        isMobile
      >
        <LockVisibleProbe />
        <WiredDocumentBody>
          <div style={{ height: "1600px" }}>Document body</div>
        </WiredDocumentBody>
      </PaneShell>
    );

    const viewport = screen.getByTestId("document-viewport");
    const shell = screen.getByTestId("pane-shell-root");

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 260,
    });
    fireEvent.scroll(viewport);
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "Lock chrome" }));
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", "false");
  });

  it("clears chrome overrides when an overriding child unmounts", () => {
    const { rerender } = render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
      >
        <ChromeOverrideProbe shouldOverride />
      </PaneShell>
    );

    expect(screen.getByText("Override toolbar")).toBeInTheDocument();
    expect(screen.getByText("Override action")).toBeInTheDocument();
    expect(screen.getByText("Override meta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();

    rerender(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
      >
        <div>Replacement body</div>
      </PaneShell>
    );

    expect(screen.getByText("Default toolbar")).toBeInTheDocument();
    expect(screen.getByText("Default action")).toBeInTheDocument();
    expect(screen.queryByText("Override toolbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Override action")).not.toBeInTheDocument();
    expect(screen.queryByText("Override meta")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Options" })).not.toBeInTheDocument();
  });

  it("clears chrome overrides when a mounted child stops overriding", () => {
    const { rerender } = render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
      >
        <ChromeOverrideProbe shouldOverride />
      </PaneShell>
    );

    expect(screen.getByText("Override toolbar")).toBeInTheDocument();
    expect(screen.getByText("Override action")).toBeInTheDocument();
    expect(screen.getByText("Override meta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();

    rerender(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
      >
        <ChromeOverrideProbe shouldOverride={false} />
      </PaneShell>
    );

    expect(screen.getByText("Default toolbar")).toBeInTheDocument();
    expect(screen.getByText("Default action")).toBeInTheDocument();
    expect(screen.queryByText("Override toolbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Override action")).not.toBeInTheDocument();
    expect(screen.queryByText("Override meta")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Options" })).not.toBeInTheDocument();
  });

  it("renders an icon-only Search trigger on mobile and dispatches the open event", () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen as EventListener);

    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
        isMobile
      >
        <div>Body content</div>
      </PaneShell>
    );

    const trigger = screen.getByRole("button", { name: "Search" });
    expect(trigger).not.toHaveTextContent(/\S/);

    fireEvent.click(trigger);

    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen as EventListener);
  });
});

function ChromeOverrideProbe({ shouldOverride }: { shouldOverride: boolean }) {
  usePaneChromeOverride(
    shouldOverride
      ? {
          toolbar: <div>Override toolbar</div>,
          actions: <button type="button">Override action</button>,
          meta: <div>Override meta</div>,
          options: [
            {
              id: "override-option",
              label: "Override option",
              onSelect: () => {},
            },
          ],
        }
      : {}
  );

  return <div>Override body</div>;
}

function LockVisibleProbe() {
  const paneMobileChrome = usePaneMobileChromeVisibility();

  return (
    <button
      type="button"
      onClick={() => {
        paneMobileChrome?.showMobileChrome();
        paneMobileChrome?.setMobileChromeLockedVisible(true);
      }}
    >
      Lock chrome
    </button>
  );
}

function WiredDocumentBody({ children }: { children: React.ReactNode }) {
  const onScroll = usePaneChromeScrollHandler();

  return (
    <div
      data-testid="document-viewport"
      data-pane-content="true"
      style={{
        width: "100%",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: "auto",
      }}
      onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
    >
      {children}
    </div>
  );
}
