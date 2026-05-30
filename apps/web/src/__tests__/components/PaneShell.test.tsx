import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import PaneShell, {
  usePaneChromeOverride,
  usePaneMobileChromeController,
} from "@/components/workspace/PaneShell";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";

const disabledNavigation = {
  canGoBack: false,
  canGoForward: false,
  onBack: vi.fn(),
  onForward: vi.fn(),
};

function paneSizing(input: {
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  fixedChromeWidthPx?: number;
}): EffectivePaneSizing {
  const fixedChromeWidthPx = input.fixedChromeWidthPx ?? 0;
  const primaryWidthPx = Math.min(
    input.maxWidthPx,
    Math.max(input.minWidthPx, input.widthPx)
  );
  return {
    primaryWidthPx,
    primaryMinWidthPx: input.minWidthPx,
    primaryMaxWidthPx: input.maxWidthPx,
    renderedPrimarySlotWidthPx: primaryWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMinWidthPx: input.minWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMaxWidthPx: input.maxWidthPx + fixedChromeWidthPx,
    fixedChromeWidthPx,
    storedWidthCorrectionPx: null,
  };
}

describe("PaneShell", () => {
  it("delegates keyboard resize to the focused resize handle", () => {
    const onResizePrimaryPane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={onResizePrimaryPane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Libraries" });
    expect(handle).toHaveAttribute("aria-valuemin", "320");
    expect(handle).toHaveAttribute("aria-valuemax", "1400");
    expect(handle).toHaveAttribute("aria-valuenow", "560");
    expect(handle).toHaveAttribute("aria-controls", "pane-a-body");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 576);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 544);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 320);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 1400);
  });

  it("forwards pane Back and Forward controls", () => {
    const navigation = {
      canGoBack: true,
      canGoForward: true,
      onBack: vi.fn(),
      onForward: vi.fn(),
    };
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={navigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
      >
        <div>Body content</div>
      </PaneShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back in this pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Go forward in this pane" }));

    expect(navigation.onBack).toHaveBeenCalledTimes(1);
    expect(navigation.onForward).toHaveBeenCalledTimes(1);
  });

  it("keyboard resize clamps to a raised runtime minimum", () => {
    const onResizePrimaryPane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Reader"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 500, minWidthPx: 684, maxWidthPx: 2400 })}
        bodyMode="document"
        onResizePrimaryPane={onResizePrimaryPane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Reader" });
    expect(handle).toHaveAttribute("aria-valuemin", "684");
    expect(handle).toHaveAttribute("aria-valuenow", "684");

    fireEvent.keyDown(handle, {
      key: "ArrowRight",
    });

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 700);
  });

  it("supports pointer drag resize on desktop", () => {
    const onResizePrimaryPane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={onResizePrimaryPane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Libraries" });
    fireEvent.mouseDown(handle, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 760 });
    fireEvent.mouseMove(document, { clientX: 40 });
    fireEvent.mouseUp(document);

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 720);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 320);
  });

  it("keeps Copy pane link first and renders pane options after separators", async () => {
    render(
      <PaneShell
        paneId="pane-a"
        href="/media/media-1"
        title="Designing Data-Intensive Applications"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
        options={[
          { id: "chat", label: "Chat about this document", onSelect: () => {} },
          { id: "reader-settings", label: "Reader settings", href: "/settings/reader" },
          {
            id: "delete",
            label: "Delete document",
            tone: "danger",
            separatorBefore: true,
            onSelect: () => {},
          },
        ]}
      >
        <div>Body content</div>
      </PaneShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "Options" }));

    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(within(menu).getByRole("menuitem", { name: "Copy pane link" })).toBeInTheDocument();
    });
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())
    ).toEqual([
      "Copy pane link",
      "Chat about this document",
      "Reader settings",
      "Delete document",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  });

  it("keeps mobile chrome visible while a standard-pane body scrolls", async () => {
    render(
      <PaneShell
        paneId="pane-standard"
        title="Libraries"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
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

  it("clips contained bodies without enabling document chrome scroll handling", async () => {
    render(
      <PaneShell
        paneId="pane-contained"
        title="Chat"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="contained"
        onResizePrimaryPane={() => {}}
        isMobile
      >
        <ContainedModeProbe />
      </PaneShell>
    );

    const body = screen.getByTestId("pane-shell-body");
    const shell = screen.getByTestId("pane-shell-root");

    expect(body).toHaveAttribute("data-body-mode", "contained");
    expect(body).toHaveStyle({
      display: "flex",
      flexDirection: "column",
      minHeight: "0",
      overflow: "hidden",
      overscrollBehavior: "contain",
    });
    expect(screen.getByTestId("contained-scroll-handler")).toHaveTextContent("none");

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
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 920, minWidthPx: 420, maxWidthPx: 1800 })}
        bodyMode="document"
        onResizePrimaryPane={() => {}}
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
      scrollViewportTo(viewport, scrollTop);
    };

    await expectChromeHidden(shell, false);

    scrollTo(-20);
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
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 920, minWidthPx: 420, maxWidthPx: 1800 })}
        bodyMode="document"
        onResizePrimaryPane={() => {}}
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

    scrollViewportTo(viewport, chromeHeight + 12);
    scrollViewportTo(viewport, chromeHeight + 40);

    await expectChromeHidden(shell, true);

    fireEvent.click(screen.getByRole("button", { name: "Lock chrome" }));
    await expectChromeHidden(shell, false);

    fireEvent.click(screen.getByRole("button", { name: "Release chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Release chrome" }));
    await expectChromeHidden(shell, false);

    scrollViewportTo(viewport, chromeHeight + 64);
    scrollViewportTo(viewport, chromeHeight + 92);
    await expectChromeHidden(shell, true);
  });

  it("keeps document chrome visible until all scoped locks release", async () => {
    render(
      <PaneShell
        paneId="pane-doc"
        title="Reader"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 920, minWidthPx: 420, maxWidthPx: 1800 })}
        bodyMode="document"
        onResizePrimaryPane={() => {}}
        isMobile
      >
        <TwoLocksProbe />
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

    scrollViewportTo(viewport, chromeHeight + 12);
    scrollViewportTo(viewport, chromeHeight + 40);
    await expectChromeHidden(shell, true);

    fireEvent.click(screen.getByRole("button", { name: "Lock first" }));
    fireEvent.click(screen.getByRole("button", { name: "Lock second" }));
    await expectChromeHidden(shell, false);

    fireEvent.click(screen.getByRole("button", { name: "Release first" }));
    scrollViewportTo(viewport, chromeHeight + 68);
    scrollViewportTo(viewport, chromeHeight + 96);
    await expectChromeHidden(shell, false);

    fireEvent.click(screen.getByRole("button", { name: "Release second" }));
    scrollViewportTo(viewport, chromeHeight + 120);
    scrollViewportTo(viewport, chromeHeight + 148);
    await expectChromeHidden(shell, true);
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
          navigation={disabledNavigation}
          sizing={paneSizing({ widthPx: 920, minWidthPx: 420, maxWidthPx: 1800 })}
          bodyMode="document"
          onResizePrimaryPane={() => {}}
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

      scrollViewportTo(viewport, chromeHeight + 12);
      await expectChromeHidden(shell, false);

      scrollViewportTo(viewport, chromeHeight + 40);

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
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
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
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
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
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
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
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
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

  it("renders a command palette trigger with an optional pane count on mobile", () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen as EventListener);

    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
        isMobile
        mobileCommandPalettePaneCount={3}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const trigger = screen.getByRole("button", {
      name: "Open command palette (3 open tabs)",
    });
    expect(trigger).toHaveTextContent("3");

    fireEvent.click(trigger);

    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen as EventListener);
  });

  it("composes visible secondary width without changing primary resize values", async () => {
    const onResizeSecondaryPane = vi.fn();
    const secondaryPublication = {
      groupId: "reader-tools" as const,
      defaultSurfaceId: "reader-highlights" as const,
      surfaces: [
        {
          id: "reader-highlights" as const,
          body: <div>Highlights secondary</div>,
        },
        {
          id: "reader-doc-chat" as const,
          body: <div>Document chat secondary</div>,
        },
      ],
    };
    const props = {
      paneId: "pane-a",
      title: "Reader",
      bodyMode: "document" as const,
      onResizePrimaryPane: () => {},
      onResizeSecondaryPane,
      navigation: disabledNavigation,
    };
    const { rerender } = render(
      <PaneShell
        {...props}
        sizing={paneSizing({ widthPx: 700, minWidthPx: 684, maxWidthPx: 2400 })}
      >
        <div>Body content</div>
      </PaneShell>
    );
    const shell = screen.getByTestId("pane-shell-root");
    expect(shell).toHaveStyle({ width: "700px" });
    expect(shell).toHaveStyle({ minWidth: "684px" });
    expect(shell).toHaveStyle({ maxWidth: "2400px" });
    expect(screen.getByRole("separator", { name: "Resize pane Reader" })).toHaveAttribute(
      "aria-valuenow",
      "700",
    );

    rerender(
      <PaneShell
        {...props}
        sizing={paneSizing({
          widthPx: 700,
          minWidthPx: 684,
          maxWidthPx: 2400,
        })}
        secondaryPane={{
          id: "secondary-a",
          parentPrimaryPaneId: "pane-a",
          groupId: "reader-tools",
          activeSurfaceId: "reader-doc-chat",
          widthPx: 360,
          visibility: "visible",
        }}
        secondarySizing={{
          widthPx: 360,
          minWidthPx: 280,
          maxWidthPx: 720,
          storedWidthCorrectionPx: null,
        }}
        secondaryPublication={secondaryPublication}
      >
        <div>Body content</div>
      </PaneShell>
    );
    await screen.findByTestId("workspace-secondary-pane");
    expect(shell).toHaveStyle({ width: "1060px" });
    expect(shell).toHaveStyle({ minWidth: "1044px" });
    expect(shell).toHaveStyle({ maxWidth: "2760px" });
    expect(screen.getByRole("separator", { name: "Resize pane Reader" })).toHaveAttribute(
      "aria-valuenow",
      "700",
    );

    rerender(
      <PaneShell
        {...props}
        sizing={paneSizing({ widthPx: 700, minWidthPx: 684, maxWidthPx: 2400 })}
        secondaryPane={{
          id: "secondary-a",
          parentPrimaryPaneId: "pane-a",
          groupId: "reader-tools",
          activeSurfaceId: "reader-doc-chat",
          widthPx: 360,
          visibility: "collapsed",
        }}
        secondaryPublication={secondaryPublication}
      >
        <div>Body content</div>
      </PaneShell>
    );
    expect(shell).toHaveStyle({ width: "700px" });
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
  const paneMobileChrome = usePaneMobileChromeController();
  const releaseRef = useRef<(() => void) | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          releaseRef.current?.();
          releaseRef.current =
            paneMobileChrome?.acquireVisibleLock("text-selection") ?? null;
        }}
      >
        Lock chrome
      </button>
      <button
        type="button"
        onClick={() => {
          releaseRef.current?.();
        }}
      >
        Release chrome
      </button>
    </>
  );
}

function TwoLocksProbe() {
  const paneMobileChrome = usePaneMobileChromeController();
  const firstReleaseRef = useRef<(() => void) | null>(null);
  const secondReleaseRef = useRef<(() => void) | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          firstReleaseRef.current?.();
          firstReleaseRef.current =
            paneMobileChrome?.acquireVisibleLock("text-selection") ?? null;
        }}
      >
        Lock first
      </button>
      <button
        type="button"
        onClick={() => {
          secondReleaseRef.current?.();
          secondReleaseRef.current =
            paneMobileChrome?.acquireVisibleLock("mobile-secondary") ?? null;
        }}
      >
        Lock second
      </button>
      <button
        type="button"
        onClick={() => {
          firstReleaseRef.current?.();
        }}
      >
        Release first
      </button>
      <button
        type="button"
        onClick={() => {
          secondReleaseRef.current?.();
        }}
      >
        Release second
      </button>
    </>
  );
}

function ContainedModeProbe() {
  const paneMobileChrome = usePaneMobileChromeController();

  return (
    <div>
      <span data-testid="contained-scroll-handler">
        {paneMobileChrome ? "present" : "none"}
      </span>
      <div style={{ height: "1200px" }}>Contained body</div>
    </div>
  );
}

function WiredDocumentBody({ children }: { children: ReactNode }) {
  const paneMobileChrome = usePaneMobileChromeController();

  return (
    <div
      data-testid="document-viewport"
      style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      onScroll={(event) => {
        paneMobileChrome?.onDocumentScroll({
          scrollTop: event.currentTarget.scrollTop,
          scrollHeight: event.currentTarget.scrollHeight,
          clientHeight: event.currentTarget.clientHeight,
        });
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

function scrollViewportTo(viewport: HTMLElement, scrollTop: number): void {
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
  });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => 2000,
  });
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    get: () => 500,
  });
  fireEvent.scroll(viewport);
}
