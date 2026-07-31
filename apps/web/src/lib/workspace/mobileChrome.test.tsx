import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { composeRefs } from "@/lib/ui/composeRefs";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeReaderScrollport,
  useMobileChromeSurface,
  useMobileChromeVisibleLocks,
  usePaneChromeFocusReturn,
  type MobileChromeSurfaceRole,
} from "@/lib/workspace/mobileChrome";
import type { ViewportKind } from "@/lib/renderEnvironment/types";

const COLLAPSE_PROPERTY = "--mobile-chrome-collapse";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const browserRequestAnimationFrame =
  window.requestAnimationFrame.bind(window);

function renderInEnvironment(
  children: ReactNode,
  initialViewport: ViewportKind = "mobile",
) {
  return render(children, {
    wrapper: ({ children: wrappedChildren }) =>
      withRenderEnvironment(wrappedChildren, { initialViewport }),
  });
}

function paneChrome(routeKey = "pane-a:route-a") {
  return {
    paneId: "pane-a",
    routeKey,
    identityId: "pane-a-identity",
    header: {
      kind: "section" as const,
      standingHead: "Reader",
      folio: { kind: "none" as const },
      pending: false,
    },
    activateIdentityAnchor: () => {},
    navigation: {
      canGoBack: false,
      canGoForward: false,
      onBack: () => {},
      onForward: () => {},
    },
    actions: [],
    options: [],
  };
}

function RegisteredSurface({
  role,
  showCommand = true,
  showSecondCommand = false,
  paneChromeFor = "pane-a",
  renders,
}: {
  role: MobileChromeSurfaceRole;
  showCommand?: boolean;
  showSecondCommand?: boolean;
  paneChromeFor?: string;
  renders?: MutableRefObject<number>;
}) {
  if (renders) renders.current += 1;
  const ref = useRef<HTMLDivElement>(null);
  const { motionPhase } = useMobileChrome();
  useMobileChromeSurface(ref, role, true);
  return (
    <div
      ref={ref}
      data-testid={role}
      data-pane-chrome-for={role === "AppBar" ? paneChromeFor : undefined}
      style={{
        transitionProperty: COLLAPSE_PROPERTY,
        transitionDuration:
          motionPhase.kind === "Settling" ? "180ms" : "0ms",
        transitionDelay: motionPhase.kind === "Settling" ? "20ms" : "0ms",
      }}
    >
      {showCommand ? (
        <button
          type="button"
          data-testid={`${role}-command`}
          data-pane-options-trigger={role === "AppBar" ? "true" : undefined}
        >
          {role} command
        </button>
      ) : null}
      {showSecondCommand ? (
        <button type="button" data-testid={`${role}-second-command`}>
          {role} second command
        </button>
      ) : null}
    </div>
  );
}

function ReaderScrollport({
  sourceKey,
  enabled,
  nodeIdentity,
  initialTop,
  scrollHeight,
  clientHeight,
  geometryRef,
  contentHeightPx,
  renders,
}: {
  sourceKey: string;
  enabled: boolean;
  nodeIdentity: string;
  initialTop: number;
  scrollHeight: number;
  clientHeight: number;
  geometryRef?: MutableRefObject<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }>;
  contentHeightPx?: number;
  renders?: MutableRefObject<number>;
}) {
  if (renders) renders.current += 1;
  const chromeRef = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey,
    enabled,
  });
  const prepareRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      let scrollTop = initialTop;
      Object.defineProperties(node, {
        scrollTop: {
          configurable: true,
          get: () => geometryRef?.current.scrollTop ?? scrollTop,
          set: (value: number) => {
            if (geometryRef) {
              geometryRef.current.scrollTop = value;
            } else {
              scrollTop = value;
            }
          },
        },
        scrollHeight: {
          configurable: true,
          get: () => geometryRef?.current.scrollHeight ?? scrollHeight,
        },
        clientHeight: {
          configurable: true,
          get: () => geometryRef?.current.clientHeight ?? clientHeight,
        },
      });
    },
    [clientHeight, geometryRef, initialTop, scrollHeight],
  );
  const ref = useMemo(
    () => composeRefs<HTMLDivElement>(prepareRef, chromeRef),
    [chromeRef, prepareRef],
  );
  return (
    <div
      key={nodeIdentity}
      ref={ref}
      data-testid="reader-scrollport"
      tabIndex={0}
    >
      <span
        data-testid="reader-geometry-content"
        style={
          contentHeightPx === undefined
            ? undefined
            : { display: "block", height: `${contentHeightPx}px` }
        }
      />
      <span data-testid="blank-canvas">Reading canvas</span>
      <iframe title="Embedded reader control" />
      <div
        data-reader-tap-reveal-surface="true"
        data-testid="reader-reveal-surface"
        tabIndex={0}
      >
        <span data-testid="reader-reveal-surface-content">
          Passive focusable reading surface
        </span>
        <button type="button" data-testid="reader-reveal-surface-control">
          Nested reader control
        </button>
        <span
          data-reader-tap-handled="true"
          data-testid="reader-reveal-surface-annotation"
        >
          Nested annotation
        </span>
      </div>
      <button type="button" data-testid="reader-control">
        Reader control
      </button>
      <span data-reader-tap-handled="true" data-testid="reader-annotation">
        Annotation
      </span>
      <span
        data-testid="stopped-canvas"
        onClick={(event) => event.stopPropagation()}
      >
        Stopped canvas
      </span>
    </div>
  );
}

interface HarnessProps {
  sourceKey?: string;
  readerEnabled?: boolean;
  nodeIdentity?: string;
  initialTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  geometryRef?: MutableRefObject<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }>;
  contentHeightPx?: number;
  showReader?: boolean;
  duplicateReader?: boolean;
  showAppBarCommand?: boolean;
  showSecondAppBarCommand?: boolean;
  appBarPaneId?: string;
  showToolbarCommand?: boolean;
  showToolbarSurface?: boolean;
  toolbarIdentity?: string;
  showNexusCommand?: boolean;
  interactionRoots?: number;
  surfaceRenders?: MutableRefObject<number>;
  readerRenders?: MutableRefObject<number>;
  focusCompletionRef?: MutableRefObject<Promise<void> | null>;
}

function Harness({
  sourceKey = "reader:one",
  readerEnabled = true,
  nodeIdentity = "node:one",
  initialTop = 100,
  scrollHeight = 2_000,
  clientHeight = 500,
  geometryRef,
  contentHeightPx,
  showReader = true,
  duplicateReader = false,
  showAppBarCommand = true,
  showSecondAppBarCommand = false,
  appBarPaneId = "pane-a",
  showToolbarCommand = true,
  showToolbarSurface = true,
  toolbarIdentity = "toolbar:one",
  showNexusCommand = true,
  interactionRoots = 1,
  surfaceRenders,
  readerRenders,
  focusCompletionRef,
}: HarnessProps) {
  const { motionPhase, setPaneChrome } = useMobileChrome();
  const { acquire } = useMobileChromeVisibleLocks();
  const focusReturn = usePaneChromeFocusReturn();
  const firstReleaseRef = useRef<(() => void) | null>(null);
  const secondReleaseRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    setPaneChrome(paneChrome());
    return () => setPaneChrome(null);
  }, [setPaneChrome]);

  const reader = showReader ? (
    <ReaderScrollport
      sourceKey={sourceKey}
      enabled={readerEnabled}
      nodeIdentity={nodeIdentity}
      initialTop={initialTop}
      scrollHeight={scrollHeight}
      clientHeight={clientHeight}
      geometryRef={geometryRef}
      contentHeightPx={contentHeightPx}
      renders={readerRenders}
    />
  ) : null;
  return (
    <>
      <RegisteredSurface
        role="AppBar"
        showCommand={showAppBarCommand}
        showSecondCommand={showSecondAppBarCommand}
        paneChromeFor={appBarPaneId}
        renders={surfaceRenders}
      />
      {showToolbarSurface ? (
        <RegisteredSurface
          key={toolbarIdentity}
          role="PaneToolbar"
          showCommand={showToolbarCommand}
          renders={surfaceRenders}
        />
      ) : null}
      <RegisteredSurface
        role="NexusControl"
        showCommand={showNexusCommand}
        renders={surfaceRenders}
      />
      <div data-pane-id="pane-a">
        <section
          data-pane-focus-landmark="true"
          data-testid="pane-landmark"
          tabIndex={-1}
        >
          {Array.from({ length: interactionRoots }, (_, index) => (
            <div
              key={index}
              data-mobile-reader-interaction-root="true"
              data-testid={`interaction-root-${index}`}
            >
              {index === 0 ? reader : null}
            </div>
          ))}
          {duplicateReader ? (
            <ReaderScrollport
              sourceKey="reader:duplicate"
              enabled
              nodeIdentity="node:duplicate"
              initialTop={0}
              scrollHeight={2_000}
              clientHeight={500}
            />
          ) : null}
          <button
            type="button"
            data-pane-chrome-focus="true"
            data-testid="desktop-clipped-command"
          >
            Desktop command
          </button>
          <output data-testid="phase">{motionPhase.kind}</output>
          <button
            type="button"
            data-testid="lock-first"
            onClick={() => {
              firstReleaseRef.current = acquire("text-selection");
            }}
          />
          <button
            type="button"
            data-testid="lock-second"
            onClick={() => {
              secondReleaseRef.current = acquire("pane-find");
            }}
          />
          <button
            type="button"
            data-testid="release-first"
            onClick={() => firstReleaseRef.current?.()}
          />
          <button
            type="button"
            data-testid="release-second"
            onClick={() => secondReleaseRef.current?.()}
          />
          <button
            type="button"
            data-testid="focus-return"
            onClick={() => {
              const completion = focusReturn.focus("pane-a");
              if (focusCompletionRef) focusCompletionRef.current = completion;
            }}
          />
        </section>
      </div>
    </>
  );
}

describe("MobileChromeProvider", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let viewportMobile: boolean;
  let reducedMotion: boolean;
  let mediaChangeListeners: Map<string, Set<() => void>>;

  beforeEach(() => {
    frames = new Map();
    nextFrameId = 0;
    viewportMobile = true;
    reducedMotion = false;
    mediaChangeListeners = new Map();
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = (nextFrameId += 1);
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    vi.spyOn(window, "matchMedia").mockImplementation(
      ((query: string) => {
        const listeners =
          mediaChangeListeners.get(query) ?? new Set<() => void>();
        mediaChangeListeners.set(query, listeners);
        const mediaQuery = {
          media: query,
          onchange: null,
          addEventListener: (_type: string, listener: () => void) => {
            listeners.add(listener);
          },
          removeEventListener: (_type: string, listener: () => void) => {
            listeners.delete(listener);
          },
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        } as unknown as MediaQueryList;
        Object.defineProperty(mediaQuery, "matches", {
          get: () =>
            query === REDUCED_MOTION_QUERY
              ? reducedMotion
              : viewportMobile,
        });
        return mediaQuery;
      }) as typeof window.matchMedia,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
  });

  function flushFrame(): void {
    const queued = [...frames.values()];
    frames.clear();
    act(() => queued.forEach((callback) => callback(0)));
  }

  function publishMediaChange(query: string): void {
    act(() => {
      for (const listener of mediaChangeListeners.get(query) ?? []) {
        listener();
      }
    });
  }

  function publishViewportChange(): void {
    act(() => {
      for (const [query, listeners] of mediaChangeListeners) {
        if (query === REDUCED_MOTION_QUERY) continue;
        for (const listener of listeners) listener();
      }
    });
  }

  function progress(role: MobileChromeSurfaceRole): string {
    return screen
      .getByTestId(role)
      .style.getPropertyValue(COLLAPSE_PROPERTY);
  }

  function setReaderTop(top: number): HTMLElement {
    const reader = screen.getByTestId("reader-scrollport");
    reader.scrollTop = top;
    return reader;
  }

  function startPartialSettle(top = 132): void {
    flushFrame();
    fireEvent.scroll(setReaderTop(top));
    flushFrame();
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");
  }

  function dispatchCollapseTransition(
    role: MobileChromeSurfaceRole,
    type: "transitionrun" | "transitionend" | "transitioncancel",
  ): void {
    screen
      .getByTestId(role)
      .dispatchEvent(
        new TransitionEvent(type, {
          bubbles: true,
          propertyName: COLLAPSE_PROPERTY,
        }),
      );
  }

  it("tracks one real scrollport proportionally and reveals at the reverse endpoint", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();

    fireEvent.scroll(setReaderTop(132));
    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    flushFrame();

    expect(progress("AppBar")).toBe("0.375");
    expect(progress("PaneToolbar")).toBe("0.375");
    expect(progress("NexusControl")).toBe("0.375");

    fireEvent.scroll(setReaderTop(300));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
    expect(progress("AppBar")).toBe("1");

    fireEvent.scroll(setReaderTop(200));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");
  });

  it("keeps short content visible", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness initialTop={30} scrollHeight={400} clientHeight={500} />
      </MobileChromeProvider>,
    );
    flushFrame();

    fireEvent.scroll(setReaderTop(30));
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");
  });

  it("defects immediately when two reader scrollports are enabled", () => {
    expect(() =>
      renderInEnvironment(
        <MobileChromeProvider>
          <Harness duplicateReader />
        </MobileChromeProvider>,
      ),
    ).toThrow("Mobile chrome already has an enabled reader scrollport");
  });

  it("defects when the active pane publishes two interaction roots", () => {
    expect(() =>
      renderInEnvironment(
        <MobileChromeProvider>
          <Harness interactionRoots={2} />
        </MobileChromeProvider>,
      ),
    ).toThrow(
      "Active pane pane-a has more than one mobile reader interaction root",
    );
  });

  it("rebaselines late mount, source, enable, node, StrictMode replay, and unmount", () => {
    const view = renderInEnvironment(
      <StrictMode>
        <MobileChromeProvider>
          <Harness showReader={false} />
        </MobileChromeProvider>
      </StrictMode>,
    );
    view.rerender(
      <StrictMode>
        <MobileChromeProvider>
          <Harness />
        </MobileChromeProvider>
      </StrictMode>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(108));
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    fireEvent.scroll(setReaderTop(116));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    expect(progress("AppBar")).toBe("0.125");

    const sourceNode = screen.getByTestId("reader-scrollport");
    const removeSourceListeners = vi.spyOn(
      sourceNode,
      "removeEventListener",
    );
    view.rerender(
      <StrictMode>
        <MobileChromeProvider>
          <Harness sourceKey="reader:two" initialTop={300} />
        </MobileChromeProvider>
      </StrictMode>,
    );
    flushFrame();
    expect(
      removeSourceListeners.mock.calls.filter(([type]) => type === "scroll"),
    ).toHaveLength(1);
    expect(progress("AppBar")).toBe("0");
    fireEvent.scroll(setReaderTop(308));
    fireEvent.scroll(setReaderTop(316));
    flushFrame();
    expect(progress("AppBar")).toBe("0.125");

    view.rerender(
      <StrictMode>
        <MobileChromeProvider>
          <Harness
            sourceKey="reader:two"
            readerEnabled={false}
            initialTop={500}
          />
        </MobileChromeProvider>
      </StrictMode>,
    );
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    view.rerender(
      <StrictMode>
        <MobileChromeProvider>
          <Harness sourceKey="reader:two" initialTop={500} />
        </MobileChromeProvider>
      </StrictMode>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(508));
    fireEvent.scroll(setReaderTop(516));
    flushFrame();
    expect(progress("AppBar")).toBe("0.125");

    const firstNode = screen.getByTestId("reader-scrollport");
    view.rerender(
      <StrictMode>
        <MobileChromeProvider>
          <Harness
            sourceKey="reader:two"
            nodeIdentity="node:two"
            initialTop={700}
          />
        </MobileChromeProvider>
      </StrictMode>,
    );
    flushFrame();
    const replacement = screen.getByTestId("reader-scrollport");
    expect(replacement).not.toBe(firstNode);
    const removeReplacementListeners = vi.spyOn(
      replacement,
      "removeEventListener",
    );
    view.unmount();
    expect(
      removeReplacementListeners.mock.calls.filter(
        ([type]) => type === "scroll",
      ),
    ).toHaveLength(1);
    expect(
      removeReplacementListeners.mock.calls.filter(
        ([type, _listener, options]) => type === "load" && options === true,
      ),
    ).toHaveLength(1);
  });

  it("refreshes content and viewport geometry without resetting synchronized presentation", async () => {
    const geometryRef = {
      current: {
        scrollTop: 100,
        scrollHeight: 2_000,
        clientHeight: 500,
      },
    };
    const view = renderInEnvironment(
      <MobileChromeProvider>
        <Harness geometryRef={geometryRef} contentHeightPx={40} />
      </MobileChromeProvider>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(132));
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    geometryRef.current.scrollTop = 500;
    view.rerender(
      <MobileChromeProvider>
        <Harness geometryRef={geometryRef} contentHeightPx={80} />
      </MobileChromeProvider>,
    );
    await act(
      () =>
        new Promise<void>((resolve) => {
          browserRequestAnimationFrame(() => resolve());
        }),
    );
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    expect(progress("AppBar")).toBe("0.375");

    fireEvent.scroll(setReaderTop(508));
    flushFrame();
    expect(progress("AppBar")).toBe("0.5");

    geometryRef.current.scrollTop = 700;
    fireEvent.load(screen.getByTestId("reader-geometry-content"));
    flushFrame();
    fireEvent.scroll(setReaderTop(708));
    flushFrame();
    expect(progress("AppBar")).toBe("0.625");

    geometryRef.current.scrollTop = 900;
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      throw new Error("Chromium must expose visualViewport");
    }
    act(() => visualViewport.dispatchEvent(new Event("resize")));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    expect(progress("AppBar")).toBe("0.625");

    geometryRef.current.scrollHeight = 400;
    geometryRef.current.clientHeight = 500;
    act(() => window.dispatchEvent(new Event("resize")));
    flushFrame();
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");
  });

  it("rebaselines live reader geometry across desktop and mobile transitions", async () => {
    viewportMobile = false;
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
      "desktop",
    );
    setReaderTop(300);

    viewportMobile = true;
    publishViewportChange();
    await act(async () => Promise.resolve());
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    fireEvent.scroll(setReaderTop(308));
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    fireEvent.scroll(setReaderTop(316));
    flushFrame();
    expect(progress("AppBar")).toBe("0.125");

    viewportMobile = false;
    publishViewportChange();
    await act(async () => Promise.resolve());
    flushFrame();
    setReaderTop(700);

    viewportMobile = true;
    publishViewportChange();
    await act(async () => Promise.resolve());
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");
    fireEvent.scroll(setReaderTop(708));
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    fireEvent.scroll(setReaderTop(716));
    flushFrame();
    expect(progress("AppBar")).toBe("0.125");
  });

  it("derives a focused registered surface lock on real render-environment mobile entry", async () => {
    viewportMobile = false;
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
      "desktop",
    );
    act(() => screen.getByTestId("AppBar-command").focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");

    viewportMobile = true;
    publishViewportChange();
    await act(async () => Promise.resolve());
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
  });

  it("holds overlapping locks and rebaselines the final release from live geometry", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(132));
    flushFrame();

    fireEvent.click(screen.getByTestId("lock-first"));
    fireEvent.click(screen.getByTestId("lock-second"));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    fireEvent.scroll(setReaderTop(500));
    fireEvent.click(screen.getByTestId("release-first"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    fireEvent.click(screen.getByTestId("release-second"));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");

    fireEvent.scroll(setReaderTop(508));
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    fireEvent.scroll(setReaderTop(516));
    flushFrame();
    expect(progress("AppBar")).toBe("0.125");
  });

  it("arms the computed settle deadline only after presentation commits", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    startPartialSettle();

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");

    flushFrame();
    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("cancels settling under a live lock and rebaselines its release", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    startPartialSettle();
    flushFrame();

    fireEvent.click(screen.getByTestId("lock-first"));
    flushFrame();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    expect(progress("AppBar")).toBe("0");

    fireEvent.click(screen.getByTestId("release-first"));
    fireEvent.scroll(setReaderTop(140));
    fireEvent.scroll(setReaderTop(148));
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    expect(progress("AppBar")).toBe("0.125");
  });

  it("accepts non-AppBar completion and restarts a cancelled settle from live progress", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    startPartialSettle(140);
    flushFrame();
    act(() => {
      dispatchCollapseTransition("PaneToolbar", "transitionrun");
      dispatchCollapseTransition("PaneToolbar", "transitionend");
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");

    fireEvent.scroll(setReaderTop(120));
    flushFrame();
    act(() => vi.advanceTimersByTime(120));
    flushFrame();
    screen
      .getByTestId("NexusControl")
      .style.setProperty(COLLAPSE_PROPERTY, "0.3");
    act(() => {
      dispatchCollapseTransition("NexusControl", "transitionrun");
      dispatchCollapseTransition("NexusControl", "transitioncancel");
    });

    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");
    expect(progress("AppBar")).toBe("0.3");
    flushFrame();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("ignores stale settle end and cancel events until the newer transition generation runs", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    startPartialSettle(140);
    flushFrame();
    act(() => {
      dispatchCollapseTransition("AppBar", "transitionrun");
    });

    fireEvent.scroll(setReaderTop(120));
    flushFrame();
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");
    flushFrame();

    act(() => {
      dispatchCollapseTransition("AppBar", "transitionend");
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");

    screen
      .getByTestId("AppBar")
      .style.setProperty(COLLAPSE_PROPERTY, "0.3");
    expect(progress("PaneToolbar")).toBe("1");
    act(() => {
      dispatchCollapseTransition("AppBar", "transitioncancel");
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");
    expect(progress("PaneToolbar")).toBe("1");

    act(() => {
      dispatchCollapseTransition("PaneToolbar", "transitionrun");
      dispatchCollapseTransition("PaneToolbar", "transitionend");
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
  });

  it("derives the focus lock from live focus across movement and child removal", async () => {
    const view = renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    act(() => screen.getByTestId("AppBar-command").focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    act(() => screen.getByTestId("PaneToolbar-command").focus());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    view.rerender(
      <MobileChromeProvider>
        <Harness showToolbarCommand={false} />
      </MobileChromeProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");

    view.rerender(
      <MobileChromeProvider>
        <Harness toolbarIdentity="toolbar:two" />
      </MobileChromeProvider>,
    );
    act(() => screen.getByTestId("PaneToolbar-command").focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    view.rerender(
      <MobileChromeProvider>
        <Harness showToolbarSurface={false} />
      </MobileChromeProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("keeps one focus lock while focus moves between controls in one registered surface", async () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness showSecondAppBarCommand />
      </MobileChromeProvider>,
    );

    act(() => screen.getByTestId("AppBar-command").focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    act(() => screen.getByTestId("AppBar-second-command").focus());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("AppBar-second-command")).toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    act(() => screen.getByTestId("pane-landmark").focus());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("hands reader-root pointer intent off from chrome without deleting public locks", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness showReader={false} />
      </MobileChromeProvider>,
    );
    const command = screen.getByTestId("NexusControl-command");
    act(() => command.focus());
    fireEvent.click(screen.getByTestId("lock-first"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    fireEvent.pointerDown(screen.getByTestId("interaction-root-0"), {
      button: 0,
      isPrimary: true,
      pointerType: "touch",
    });

    expect(command).not.toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    fireEvent.click(screen.getByTestId("release-first"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("reveals a blank descendant inside a focusable scrollport only after window bubbling", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(300));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");

    fireEvent.click(screen.getByTestId("reader-control"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
    fireEvent.click(screen.getByTitle("Embedded reader control"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
    fireEvent.click(screen.getByTestId("reader-annotation"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
    fireEvent.click(screen.getByTestId("stopped-canvas"));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");

    fireEvent.click(screen.getByTestId("blank-canvas"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("treats a marked focusable reading surface as passive without exempting nested controls", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(300));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");

    fireEvent.click(screen.getByTestId("reader-reveal-surface-control"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
    fireEvent.click(screen.getByTestId("reader-reveal-surface-annotation"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");

    fireEvent.click(screen.getByTestId("reader-reveal-surface-content"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("does not treat a live selection as a blank-canvas reveal", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(300));
    flushFrame();
    const canvas = screen.getByTestId("blank-canvas");
    const range = document.createRange();
    range.selectNodeContents(canvas);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.click(canvas);

    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
  });

  it("reveals before focus return and falls back to the pane landmark", async () => {
    const focusCompletionRef = {
      current: null,
    } as MutableRefObject<Promise<void> | null>;
    const view = renderInEnvironment(
      <MobileChromeProvider>
        <Harness focusCompletionRef={focusCompletionRef} />
      </MobileChromeProvider>,
    );
    fireEvent.click(screen.getByTestId("focus-return"));
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    flushFrame();
    await focusCompletionRef.current;
    expect(screen.getByTestId("AppBar-command")).toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    view.rerender(
      <MobileChromeProvider>
        <Harness
          focusCompletionRef={focusCompletionRef}
          showAppBarCommand={false}
          showToolbarCommand={false}
          showNexusCommand={false}
        />
      </MobileChromeProvider>,
    );
    act(() => screen.getByTestId("pane-landmark").focus());
    fireEvent.click(screen.getByTestId("focus-return"));
    flushFrame();
    await focusCompletionRef.current;

    expect(screen.getByTestId("pane-landmark")).toHaveFocus();
    expect(screen.getByTestId("desktop-clipped-command")).not.toHaveFocus();

    view.rerender(
      <MobileChromeProvider>
        <Harness
          focusCompletionRef={focusCompletionRef}
          appBarPaneId="pane-b"
        />
      </MobileChromeProvider>,
    );
    act(() => screen.getByTestId("pane-landmark").focus());
    fireEvent.click(screen.getByTestId("focus-return"));
    flushFrame();
    await focusCompletionRef.current;

    expect(screen.getByTestId("pane-landmark")).toHaveFocus();
    expect(screen.getByTestId("AppBar-command")).not.toHaveFocus();
  });

  it("pins reduced motion, then rebaselines when the preference clears", () => {
    reducedMotion = true;
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(300));
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    reducedMotion = false;
    publishMediaChange(REDUCED_MOTION_QUERY);
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    fireEvent.scroll(setReaderTop(308));
    fireEvent.scroll(setReaderTop(316));
    flushFrame();
    expect(progress("AppBar")).toBe("0.125");
  });

  it("does not rerender volatile consumers for same-direction tracking samples", () => {
    const surfaceRenders = { current: 0 };
    const readerRenders = { current: 0 };
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness
          surfaceRenders={surfaceRenders}
          readerRenders={readerRenders}
        />
      </MobileChromeProvider>,
    );
    flushFrame();
    fireEvent.scroll(setReaderTop(116));
    flushFrame();
    const trackingSurfaceRenders = surfaceRenders.current;
    const trackingReaderRenders = readerRenders.current;

    fireEvent.scroll(setReaderTop(132));
    fireEvent.scroll(setReaderTop(140));
    fireEvent.scroll(setReaderTop(148));
    flushFrame();

    expect(surfaceRenders.current).toBe(trackingSurfaceRenders);
    expect(readerRenders.current).toBe(trackingReaderRenders);
  });

  it("coalesces same-frame tracking samples into one progress write per registered surface", () => {
    renderInEnvironment(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();
    const writeSpies = (
      ["AppBar", "PaneToolbar", "NexusControl"] as const
    ).map((role) => {
      const surface = screen.getByTestId(role);
      const spy = vi.spyOn(surface.style, "setProperty");
      spy.mockClear();
      return { role, spy };
    });

    fireEvent.scroll(setReaderTop(116));
    fireEvent.scroll(setReaderTop(132));
    fireEvent.scroll(setReaderTop(140));
    fireEvent.scroll(setReaderTop(148));

    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    for (const { spy } of writeSpies) {
      expect(spy).not.toHaveBeenCalled();
    }

    flushFrame();

    for (const { role, spy } of writeSpies) {
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(COLLAPSE_PROPERTY, "0.625");
      expect(progress(role)).toBe("0.625");
    }
  });
});
