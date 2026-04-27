import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
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

  it("renders standard pane options in every header", async () => {
    render(
      <PaneShell
        paneId="pane-a"
        href="/settings/keys"
        title="API Keys"
        widthPx={560}
        minWidthPx={320}
        maxWidthPx={1400}
        bodyMode="standard"
        onResizePane={() => {}}
      >
        <div>Body content</div>
      </PaneShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "Options" }));

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Copy pane link" })).toBeInTheDocument();
    });
  });

  it("keeps mobile chrome visible while a standard-pane body scrolls", async () => {
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

    await expectChromeHidden(shell, false);

    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => 200,
    });
    fireEvent.scroll(body);

    await expectChromeHidden(shell, false);
  });

  it("hides mobile document chrome only after deliberate downward scroll and reveals it only after deliberate upward scroll", async () => {
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
    const chromeHeight = Math.ceil(
      screen.getByTestId("pane-shell-chrome").getBoundingClientRect().height
    );
    const scrollTo = (scrollTop: number) => {
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
      });
      fireEvent.scroll(viewport);
    };

    await expectChromeHidden(shell, false);

    scrollTo(Math.max(1, chromeHeight - 8));
    await expectChromeHidden(shell, false);
    expect(viewport.scrollTop).toBe(Math.max(1, chromeHeight - 8));

    scrollTo(chromeHeight + 12);
    await expectChromeHidden(shell, false);
    expect(viewport.scrollTop).toBe(chromeHeight + 12);

    scrollTo(chromeHeight + 40);
    await expectChromeHidden(shell, true);
    expect(viewport.scrollTop).toBe(chromeHeight + 40);

    scrollTo(chromeHeight + 34);
    await expectChromeHidden(shell, true);
    expect(viewport.scrollTop).toBe(chromeHeight + 34);

    scrollTo(chromeHeight + 22);
    await expectChromeHidden(shell, true);
    expect(viewport.scrollTop).toBe(chromeHeight + 22);

    scrollTo(chromeHeight + 18);
    await expectChromeHidden(shell, false);
    expect(viewport.scrollTop).toBe(chromeHeight + 18);
  });

  it("keeps document chrome visible while a child locks it open", async () => {
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
    const chromeHeight = Math.ceil(
      screen.getByTestId("pane-shell-chrome").getBoundingClientRect().height
    );

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => chromeHeight + 12,
    });
    fireEvent.scroll(viewport);
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => chromeHeight + 40,
    });
    fireEvent.scroll(viewport);

    await expectChromeHidden(shell, true);

    fireEvent.click(screen.getByRole("button", { name: "Lock chrome" }));
    await expectChromeHidden(shell, false);
  });

  it("pins mobile document chrome visible when reduced motion is active", async () => {
    const originalMatchMedia = window.matchMedia;
    const matchMediaMock = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMediaMock,
    });

    try {
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
      const chromeHeight = Math.ceil(
        screen.getByTestId("pane-shell-chrome").getBoundingClientRect().height
      );

      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => chromeHeight + 12,
      });
      fireEvent.scroll(viewport);
      await expectChromeHidden(shell, false);

      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => chromeHeight + 40,
      });
      fireEvent.scroll(viewport);

      await expectChromeHidden(shell, false);
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
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
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
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
        if (!paneMobileChrome) {
          return;
        }
        paneMobileChrome.showMobileChrome();
        paneMobileChrome.setMobileChromeLockedVisible(true);
      }}
    >
      Lock chrome
    </button>
  );
}

function WiredDocumentBody({ children }: { children: ReactNode }) {
  const paneChromeScrollHandler = usePaneChromeScrollHandler();

  return (
    <div
      data-testid="document-viewport"
      style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      onScroll={(event) => {
        paneChromeScrollHandler?.(event.currentTarget.scrollTop);
      }}
    >
      {children}
    </div>
  );
}

async function expectChromeHidden(shell: HTMLElement, hidden: boolean): Promise<void> {
  await waitFor(() => {
    expect(shell).toHaveAttribute("data-mobile-chrome-hidden", hidden ? "true" : "false");
  });
}
