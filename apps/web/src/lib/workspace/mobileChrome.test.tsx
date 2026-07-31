import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  StrictMode,
  useCallback,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type MutableRefObject,
} from "react";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeReaderScrollport,
  useMobileChromeSurface,
  useMobileChromeVisibleLocks,
  type MobileChromeSurfaceRole,
} from "@/lib/workspace/mobileChrome";

const viewport = vi.hoisted(() => ({ mobile: true }));
const noopActivateIdentityAnchor = () => {};

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => viewport.mobile,
}));

function configureScrollport(
  node: HTMLElement,
  {
    scrollTop,
    scrollHeight,
    clientHeight,
  }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  },
) {
  Object.defineProperties(node, {
    scrollTop: { configurable: true, writable: true, value: scrollTop },
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
}

function RegisteredSurface({
  role,
  focusOnMount = false,
}: {
  role: MobileChromeSurfaceRole;
  focusOnMount?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const firstControlRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (focusOnMount) firstControlRef.current?.focus();
  }, [focusOnMount]);
  useMobileChromeSurface(ref, role, true);
  return (
    <div ref={ref} data-testid={role} tabIndex={-1}>
      <button ref={firstControlRef} type="button" data-testid={`${role}-first`} />
      <button type="button" data-testid={`${role}-second`} />
    </div>
  );
}

function RootControlSurface() {
  const ref = useRef<HTMLButtonElement>(null);
  useMobileChromeSurface(ref, "NexusControl", true);
  return <button ref={ref} type="button" data-testid="NexusControl-root" />;
}

function ReaderScrollport({
  sourceKey = "reader-a",
  enabled = true,
  initialScrollTop = 100,
  scrollHeight = 2_000,
  clientHeight = 500,
  testId = "reader",
}: {
  sourceKey?: string;
  enabled?: boolean;
  initialScrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  testId?: string;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey,
    enabled,
  });
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (node && node.dataset.scrollportConfigured !== "true") {
        configureScrollport(node, {
          scrollTop: initialScrollTop,
          scrollHeight,
          clientHeight,
        });
        node.dataset.scrollportConfigured = "true";
      }
      chromeRef(node);
    },
    [chromeRef, clientHeight, initialScrollTop, scrollHeight],
  );
  return (
    <div ref={setRef} data-testid={testId}>
      <span data-testid={`${testId}-blank`}>Reader canvas</span>
      <button type="button" data-testid={`${testId}-control`}>
        Reader control
      </button>
      <span
        data-testid={`${testId}-handled`}
        onClick={(event) => event.preventDefault()}
      >
        Handled canvas
      </span>
      <span data-highlight-id="highlight-a" data-testid={`${testId}-highlight`}>
        Highlight
      </span>
    </div>
  );
}

function MotionProbe({ renders }: { renders?: MutableRefObject<number> }) {
  if (renders) renders.current += 1;
  const { motionPhase, finishSettle } = useMobileChrome();
  return (
    <>
      <output data-testid="phase">{motionPhase.kind}</output>
      <button type="button" data-testid="finish" onClick={finishSettle} />
    </>
  );
}

function LockControls() {
  const visibleLocks = useMobileChromeVisibleLocks();
  const releaseFirstRef = useRef<(() => void) | null>(null);
  const releaseSecondRef = useRef<(() => void) | null>(null);
  return (
    <>
      <button
        type="button"
        data-testid="lock-first"
        onClick={() => {
          releaseFirstRef.current = visibleLocks.acquire("text-selection");
        }}
      />
      <button
        type="button"
        data-testid="lock-second"
        onClick={() => {
          releaseSecondRef.current = visibleLocks.acquire("pdf-selection");
        }}
      />
      <button
        type="button"
        data-testid="release-first"
        onClick={() => releaseFirstRef.current?.()}
      />
      <button
        type="button"
        data-testid="release-first-again"
        onClick={() => releaseFirstRef.current?.()}
      />
      <button
        type="button"
        data-testid="release-second"
        onClick={() => releaseSecondRef.current?.()}
      />
    </>
  );
}

function PanePublisher({ routeKey }: { routeKey: string }) {
  const { setPaneChrome } = useMobileChrome();
  useLayoutEffect(() => {
    setPaneChrome({
      paneId: "pane-a",
      routeKey,
      identityId: "pane-a-identity",
      header: {
        kind: "section",
        standingHead: "Pane A",
        folio: { kind: "none" },
        pending: false,
      },
      activateIdentityAnchor: noopActivateIdentityAnchor,
      navigation: {
        canGoBack: false,
        canGoForward: false,
        onBack: () => {},
        onForward: () => {},
      },
      actions: [],
      options: [],
    });
    return () => setPaneChrome(null);
  }, [routeKey, setPaneChrome]);
  return null;
}

function Harness({
  sourceKey,
  enabled,
  showReader = true,
  readerKey = "reader-node-a",
  showAppBar = true,
  showLocks = true,
  focusAppBarOnMount = false,
  renders,
}: {
  sourceKey?: string;
  enabled?: boolean;
  showReader?: boolean;
  readerKey?: string;
  showAppBar?: boolean;
  showLocks?: boolean;
  focusAppBarOnMount?: boolean;
  renders?: MutableRefObject<number>;
}) {
  return (
    <>
      {showAppBar ? (
        <RegisteredSurface
          role="AppBar"
          focusOnMount={focusAppBarOnMount}
        />
      ) : null}
      <RegisteredSurface role="PaneToolbar" />
      <RegisteredSurface role="NexusControl" />
      {showReader ? (
        <ReaderScrollport
          key={readerKey}
          sourceKey={sourceKey}
          enabled={enabled}
        />
      ) : null}
      {showLocks ? <LockControls /> : null}
      <MotionProbe renders={renders} />
      <button type="button" data-testid="outside">
        Outside
      </button>
    </>
  );
}

describe("MobileChromeProvider", () => {
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let reducedMotion = false;
  let reducedMotionListeners = new Set<() => void>();
  let removeMediaListener = vi.fn();

  beforeEach(() => {
    viewport.mobile = true;
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = (nextFrame += 1);
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    vi.spyOn(window, "matchMedia").mockImplementation(
      ((query: string) =>
        ({
          get matches() {
            return (
              query === "(prefers-reduced-motion: reduce)" && reducedMotion
            );
          },
          media: query,
          onchange: null,
          addEventListener: vi.fn(
            (eventName: string, listener: () => void) => {
              if (eventName === "change") reducedMotionListeners.add(listener);
            },
          ),
          removeEventListener: removeMediaListener,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList) as typeof window.matchMedia,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    frames = new Map();
    nextFrame = 0;
    reducedMotion = false;
    reducedMotionListeners = new Set();
    removeMediaListener = vi.fn();
    document.body.innerHTML = "";
  });

  function flushFrame() {
    const queued = [...frames.values()];
    frames.clear();
    act(() => queued.forEach((callback) => callback(0)));
  }

  function renderHarness(
    props: ComponentProps<typeof Harness> = {},
  ) {
    return render(
      <MobileChromeProvider>
        <Harness {...props} />
      </MobileChromeProvider>,
    );
  }

  function reader(testId = "reader") {
    return screen.getByTestId(testId);
  }

  function scrollTo(scrollTop: number, testId = "reader") {
    const node = reader(testId);
    node.scrollTop = scrollTop;
    fireEvent.scroll(node);
  }

  function progress(role: MobileChromeSurfaceRole) {
    return screen
      .getByTestId(role)
      .style.getPropertyValue("--mobile-chrome-collapse");
  }

  function click(testId: string) {
    fireEvent.click(screen.getByTestId(testId));
  }

  it("registers the real scrollport immediately and coalesces all three surface writes", () => {
    renderHarness();
    flushFrame();

    scrollTo(116);
    scrollTo(132);

    expect(frames.size).toBe(1);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");
    expect(progress("PaneToolbar")).toBe("0.375");
    expect(progress("NexusControl")).toBe("0.375");
  });

  it("uses the first forward gesture after a top baseline", () => {
    render(
      <MobileChromeProvider>
        <RegisteredSurface role="AppBar" />
        <ReaderScrollport initialScrollTop={0} />
        <MotionProbe />
      </MobileChromeProvider>,
    );
    flushFrame();

    scrollTo(40);
    flushFrame();

    expect(progress("AppBar")).toBe("0.5");
  });

  it("keeps short content fully visible", () => {
    render(
      <MobileChromeProvider>
        <RegisteredSurface role="AppBar" />
        <ReaderScrollport
          initialScrollTop={0}
          scrollHeight={500}
          clientHeight={500}
        />
        <MotionProbe />
      </MobileChromeProvider>,
    );
    flushFrame();

    scrollTo(200);
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");
  });

  it("defects when more than one enabled reader scrollport registers", () => {
    expect(() =>
      render(
        <MobileChromeProvider>
          <ReaderScrollport testId="reader-a" />
          <ReaderScrollport testId="reader-b" />
        </MobileChromeProvider>,
      ),
    ).toThrow("Mobile chrome already has an enabled reader scrollport");
  });

  it("supports StrictMode callback-ref replay without duplicate registration", () => {
    expect(() =>
      render(
        <StrictMode>
          <MobileChromeProvider>
            <Harness />
          </MobileChromeProvider>
        </StrictMode>,
      ),
    ).not.toThrow();
    flushFrame();
    scrollTo(132);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");
  });

  it("registers a late mount and cleans up when disabled or unmounted", () => {
    const view = renderHarness({ showReader: false });
    flushFrame();
    view.rerender(
      <MobileChromeProvider>
        <Harness showReader />
      </MobileChromeProvider>,
    );
    flushFrame();
    scrollTo(132);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    view.rerender(
      <MobileChromeProvider>
        <Harness enabled={false} />
      </MobileChromeProvider>,
    );
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    scrollTo(500);
    flushFrame();
    expect(progress("AppBar")).toBe("0");

    view.rerender(
      <MobileChromeProvider>
        <Harness enabled />
      </MobileChromeProvider>,
    );
    flushFrame();
    scrollTo(532);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    view.rerender(
      <MobileChromeProvider>
        <Harness showReader={false} />
      </MobileChromeProvider>,
    );
    flushFrame();
    expect(progress("AppBar")).toBe("0");
  });

  it("rebaselines node replacement and source changes from live geometry", () => {
    const view = renderHarness();
    flushFrame();
    scrollTo(132);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    view.rerender(
      <MobileChromeProvider>
        <Harness readerKey="reader-node-b" sourceKey="reader-a" />
      </MobileChromeProvider>,
    );
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    scrollTo(132);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    reader().scrollTop = 500;
    view.rerender(
      <MobileChromeProvider>
        <Harness readerKey="reader-node-b" sourceKey="reader-b" />
      </MobileChromeProvider>,
    );
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    scrollTo(532);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");
  });

  it("pins only real controls and releases after focus moves within and then outside chrome", () => {
    renderHarness();
    const surface = screen.getByTestId("AppBar");
    const first = screen.getByTestId("AppBar-first");
    const second = screen.getByTestId("AppBar-second");

    act(() => surface.focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    act(() => first.focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    act(() => second.focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    act(() => screen.getByTestId("outside").focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("pins when the registered Nexus surface is itself the focused control", () => {
    render(
      <MobileChromeProvider>
        <RegisteredSurface role="AppBar" />
        <RootControlSurface />
        <ReaderScrollport />
        <MotionProbe />
      </MobileChromeProvider>,
    );
    const nexus = screen.getByTestId("NexusControl-root");

    act(() => nexus.focus());

    expect(nexus).toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    fireEvent.pointerDown(reader(), { button: 0, isPrimary: true });
    expect(nexus).not.toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("reconciles a focused chrome control on registration and mobile entry", () => {
    const { unmount } = renderHarness({ focusAppBarOnMount: true });
    expect(screen.getByTestId("AppBar-first")).toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    unmount();

    viewport.mobile = false;
    const view = renderHarness();
    act(() => screen.getAllByTestId("AppBar-first").at(-1)?.focus());
    expect(screen.getAllByTestId("phase").at(-1)).toHaveTextContent("Visible");

    viewport.mobile = true;
    view.rerender(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    expect(screen.getAllByTestId("phase").at(-1)).toHaveTextContent("Pinned");
  });

  it("reader primary pointer intent blurs only registered chrome focus", () => {
    renderHarness();
    const chromeControl = screen.getByTestId("NexusControl-first");
    act(() => chromeControl.focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    fireEvent.pointerDown(reader(), { button: 0, isPrimary: true });

    expect(chromeControl).not.toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");

    const outside = screen.getByTestId("outside");
    act(() => outside.focus());
    fireEvent.pointerDown(reader(), { button: 0, isPrimary: true });
    expect(outside).toHaveFocus();
  });

  it("non-primary and secondary reader pointers do not hand off focus", () => {
    renderHarness();
    const chromeControl = screen.getByTestId("AppBar-first");
    act(() => chromeControl.focus());

    fireEvent.pointerDown(reader(), { button: 0, isPrimary: false });
    expect(chromeControl).toHaveFocus();
    fireEvent.pointerDown(reader(), { button: 2, isPrimary: true });
    expect(chromeControl).toHaveFocus();
  });

  it("preserves non-focus locks during pointer handoff", () => {
    renderHarness();
    click("lock-first");
    const chromeControl = screen.getByTestId("NexusControl-first");
    act(() => chromeControl.focus());

    fireEvent.pointerDown(reader(), { button: 0, isPrimary: true });

    expect(chromeControl).not.toHaveFocus();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    click("release-first");
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("releases a surface-owned focus lock when the surface unregisters", () => {
    const view = renderHarness();
    act(() => screen.getByTestId("AppBar-first").focus());
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    view.rerender(
      <MobileChromeProvider>
        <Harness showAppBar={false} />
      </MobileChromeProvider>,
    );

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("holds overlapping locks until idempotent final release", () => {
    renderHarness();
    click("lock-first");
    click("lock-second");
    click("release-first");
    click("release-first-again");
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    click("release-second");

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("releases locks acquired by a capability owner when it unmounts", () => {
    const view = renderHarness();
    click("lock-first");
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");

    view.rerender(
      <MobileChromeProvider>
        <Harness showLocks={false} />
      </MobileChromeProvider>,
    );

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("pins during tracking and rebaselines the final lock release from live geometry", () => {
    renderHarness();
    flushFrame();
    scrollTo(132);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    click("lock-first");
    flushFrame();
    scrollTo(500);
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    expect(progress("AppBar")).toBe("0");

    click("release-first");
    scrollTo(532);
    flushFrame();

    expect(progress("AppBar")).toBe("0.375");
  });

  it("pins and safely releases during settlement", () => {
    renderHarness();
    flushFrame();
    scrollTo(132);
    flushFrame();
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByTestId("phase")).toHaveTextContent("Settling");

    click("lock-first");
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    click("release-first");

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("reveals hidden chrome from an unhandled blank-canvas click after bubbling", async () => {
    renderHarness();
    flushFrame();
    scrollTo(300);
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");

    fireEvent.click(screen.getByTestId("reader-blank"), { button: 0 });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    flushFrame();
    expect(progress("AppBar")).toBe("0");
  });

  it("does not reveal from handled, interactive, annotated, modified, or selection clicks", async () => {
    renderHarness();
    flushFrame();
    scrollTo(300);
    flushFrame();

    fireEvent.click(screen.getByTestId("reader-handled"), { button: 0 });
    fireEvent.click(screen.getByTestId("reader-control"), { button: 0 });
    fireEvent.click(screen.getByTestId("reader-highlight"), { button: 0 });
    fireEvent.click(screen.getByTestId("reader-blank"), {
      button: 0,
      shiftKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");

    const selection = window.getSelection();
    if (!selection) throw new Error("Expected browser Selection");
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("reader-blank"));
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.click(screen.getByTestId("reader-blank"), { button: 0 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("Hidden");
    selection.removeAllRanges();
  });

  it("resets and rebaselines when the active pane route changes", () => {
    const view = render(
      <MobileChromeProvider>
        <Harness />
        <PanePublisher routeKey="pane-a:route-a" />
      </MobileChromeProvider>,
    );
    flushFrame();
    scrollTo(132);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    reader().scrollTop = 500;
    view.rerender(
      <MobileChromeProvider>
        <Harness />
        <PanePublisher routeKey="pane-a:route-b" />
      </MobileChromeProvider>,
    );
    flushFrame();
    expect(progress("AppBar")).toBe("0");
    scrollTo(532);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");
  });

  it("resets on mobile exit and rebaselines on mobile entry", () => {
    const view = renderHarness();
    flushFrame();
    scrollTo(132);
    flushFrame();
    reader().scrollTop = 500;

    viewport.mobile = false;
    view.rerender(
      <MobileChromeProvider>
        <Harness enabled={false} />
      </MobileChromeProvider>,
    );
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");

    viewport.mobile = true;
    view.rerender(
      <MobileChromeProvider>
        <Harness />
      </MobileChromeProvider>,
    );
    flushFrame();
    scrollTo(532);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");
  });

  it("pins reduced motion and rebaselines when the preference is disabled", () => {
    reducedMotion = true;
    renderHarness();
    flushFrame();
    scrollTo(500);
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    expect(progress("AppBar")).toBe("0");

    reducedMotion = false;
    if (reducedMotionListeners.size === 0) {
      throw new Error("Expected reduced-motion change listener");
    }
    act(() => {
      for (const listener of reducedMotionListeners) listener();
    });
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    scrollTo(532);
    flushFrame();

    expect(progress("AppBar")).toBe("0.375");
  });

  it("samples AppBar progress when a scroll interrupts settlement", () => {
    renderHarness();
    flushFrame();
    scrollTo(132);
    flushFrame();
    act(() => vi.advanceTimersByTime(120));
    flushFrame();
    screen
      .getByTestId("AppBar")
      .style.setProperty("--mobile-chrome-collapse", "0.3");
    screen
      .getByTestId("PaneToolbar")
      .style.setProperty("--mobile-chrome-collapse", "0.8");

    scrollTo(140);

    expect(progress("AppBar")).toBe("0.3");
    expect(progress("PaneToolbar")).toBe("0.3");
    click("finish");
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    expect(progress("AppBar")).toBe(String(0.3 + 8 / 64));
  });

  it("does not render volatile consumers for same-direction scroll frames", () => {
    const renders = { current: 0 };
    renderHarness({ renders });
    flushFrame();
    scrollTo(116);
    flushFrame();
    const trackingRenders = renders.current;

    scrollTo(132);
    scrollTo(140);
    scrollTo(148);
    flushFrame();

    expect(renders.current).toBe(trackingRenders);
  });

  it("cleans its frame, timer, reader listeners, and media listener on unmount", () => {
    const cancelFrame = vi.mocked(window.cancelAnimationFrame);
    const clearTimer = vi.spyOn(window, "clearTimeout");
    const view = renderHarness();
    const removeScrollListener = vi.spyOn(reader(), "removeEventListener");
    flushFrame();
    scrollTo(116);
    const cancelledBeforeUnmount = cancelFrame.mock.calls.length;
    const clearedBeforeUnmount = clearTimer.mock.calls.length;

    view.unmount();

    expect(cancelFrame.mock.calls.length).toBeGreaterThan(
      cancelledBeforeUnmount,
    );
    expect(clearTimer.mock.calls.length).toBeGreaterThan(clearedBeforeUnmount);
    expect(removeScrollListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );
    expect(frames.size).toBe(0);
    expect(removeMediaListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});
