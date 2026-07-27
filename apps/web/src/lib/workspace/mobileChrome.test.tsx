import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, type MutableRefObject } from "react";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeSurface,
  type MobileChromeSurfaceRole,
} from "@/lib/workspace/mobileChrome";

const viewport = vi.hoisted(() => ({ mobile: true }));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => viewport.mobile,
}));

const snapshot = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 2_000,
  clientHeight: 500,
});

function RegisteredSurface({ role }: { role: MobileChromeSurfaceRole }) {
  const ref = useRef<HTMLDivElement>(null);
  useMobileChromeSurface(ref, role);
  return <div ref={ref} data-testid={role} />;
}

function paneChrome(paneId: string, routeKey = `${paneId}:route-a`) {
  return {
    paneId,
    routeKey,
    identityId: `${paneId}-identity`,
    header: {
      kind: "section" as const,
      standingHead: paneId,
      folio: { kind: "none" as const },
      pending: false,
    },
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

function SourceOnMount({ update }: { update: boolean }) {
  const { startReaderScroll, updateReaderScroll } = useMobileChrome();
  useEffect(() => {
    startReaderScroll(snapshot(100));
    if (update) updateReaderScroll(snapshot(132));
  }, [startReaderScroll, update, updateReaderScroll]);
  return null;
}

function Surface({
  reversed = false,
  renders,
  startOnMount = false,
  updateOnMount = false,
}: {
  reversed?: boolean;
  renders?: MutableRefObject<number>;
  startOnMount?: boolean;
  updateOnMount?: boolean;
}) {
  if (renders) renders.current += 1;
  const {
    motionPhase,
    startReaderScroll,
    updateReaderScroll,
    acquireVisibleLock,
    finishSettle,
    setPaneChrome,
  } = useMobileChrome();
  const releaseFirstRef = useRef<(() => void) | null>(null);
  const releaseSecondRef = useRef<(() => void) | null>(null);
  const surfaces = (
    <>
      <RegisteredSurface role="AppBar" />
      <RegisteredSurface role="PaneToolbar" />
    </>
  );
  const reversedSurfaces = (
    <>
      <RegisteredSurface role="PaneToolbar" />
      <RegisteredSurface role="AppBar" />
    </>
  );
  return (
    <div>
      {reversed ? reversedSurfaces : surfaces}
      {startOnMount ? <SourceOnMount update={updateOnMount} /> : null}
      <div data-testid="phase">{motionPhase.kind}</div>
      <button
        type="button"
        data-testid="start"
        onClick={() => startReaderScroll(snapshot(100))}
      />
      <button
        type="button"
        data-testid="start-top"
        onClick={() => startReaderScroll(snapshot(0))}
      />
      <button
        type="button"
        data-testid="scroll-40"
        onClick={() => updateReaderScroll(snapshot(40))}
      />
      <button
        type="button"
        data-testid="scroll-116"
        onClick={() => updateReaderScroll(snapshot(116))}
      />
      <button
        type="button"
        data-testid="scroll-132"
        onClick={() => updateReaderScroll(snapshot(132))}
      />
      <button
        type="button"
        data-testid="scroll-140"
        onClick={() => updateReaderScroll(snapshot(140))}
      />
      <button
        type="button"
        data-testid="scroll-148"
        onClick={() => updateReaderScroll(snapshot(148))}
      />
      <button
        type="button"
        data-testid="scroll-top"
        onClick={() => updateReaderScroll(snapshot(8))}
      />
      <button
        type="button"
        data-testid="pane-a"
        onClick={() => setPaneChrome(paneChrome("pane-a"))}
      />
      <button
        type="button"
        data-testid="pane-a-route-b"
        onClick={() => setPaneChrome(paneChrome("pane-a", "pane-a:route-b"))}
      />
      <button
        type="button"
        data-testid="lock-first"
        onClick={() => {
          releaseFirstRef.current = acquireVisibleLock("text-selection");
        }}
      />
      <button
        type="button"
        data-testid="lock-second"
        onClick={() => {
          releaseSecondRef.current = acquireVisibleLock("pdf-selection");
        }}
      />
      <button
        type="button"
        data-testid="release-first"
        onClick={() => releaseFirstRef.current?.()}
      />
      <button
        type="button"
        data-testid="release-second"
        onClick={() => releaseSecondRef.current?.()}
      />
      <button type="button" data-testid="finish" onClick={finishSettle} />
    </div>
  );
}

function renderSurface(
  options: {
    reversed?: boolean;
    renders?: MutableRefObject<number>;
    startOnMount?: boolean;
    updateOnMount?: boolean;
  } = {},
) {
  return render(
    <MobileChromeProvider>
      <Surface {...options} />
    </MobileChromeProvider>,
  );
}

function click(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}

describe("MobileChromeProvider", () => {
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let reducedMotion = false;
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
          matches:
            query === "(prefers-reduced-motion: reduce)" && reducedMotion,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
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
    removeMediaListener = vi.fn();
    document.body.innerHTML = "";
  });

  function flushFrame() {
    const queued = [...frames.values()];
    frames.clear();
    act(() => queued.forEach((callback) => callback(0)));
  }

  function progress(role: MobileChromeSurfaceRole) {
    return screen
      .getByTestId(role)
      .style.getPropertyValue("--mobile-chrome-collapse");
  }

  it("initializes both surfaces together and coalesces tracking writes", () => {
    renderSurface();
    click("start");
    flushFrame();
    click("scroll-116");
    click("scroll-132");

    expect(frames.size).toBe(1);
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");
    expect(progress("PaneToolbar")).toBe("0.375");
  });

  it("does not erase a child source baseline while registering initial motion preference", () => {
    renderSurface({ startOnMount: true });
    flushFrame();
    click("scroll-132");
    flushFrame();

    expect(progress("AppBar")).toBe("0.375");
  });

  it("uses the first down gesture after a top start", () => {
    renderSurface();
    click("start-top");
    flushFrame();
    click("scroll-40");
    flushFrame();

    expect(progress("AppBar")).toBe("0.5");
  });

  it("samples AppBar progress when interruption registration order is reversed", () => {
    renderSurface({ reversed: true });
    click("start");
    flushFrame();
    click("scroll-132");
    flushFrame();
    act(() => vi.advanceTimersByTime(120));
    flushFrame();
    screen
      .getByTestId("AppBar")
      .style.setProperty("--mobile-chrome-collapse", "0.3");
    screen
      .getByTestId("PaneToolbar")
      .style.setProperty("--mobile-chrome-collapse", "0.8");

    click("scroll-140");

    expect(progress("AppBar")).toBe("0.3");
    expect(progress("PaneToolbar")).toBe("0.3");
    click("finish");
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Tracking");
    expect(progress("AppBar")).toBe(String(0.3 + 8 / 64));
  });

  it("does not render volatile consumers for same-direction tracking samples", () => {
    const renders = { current: 0 };
    renderSurface({ renders });
    click("start");
    flushFrame();
    click("scroll-116");
    flushFrame();
    const trackingRenders = renders.current;

    click("scroll-132");
    click("scroll-140");
    click("scroll-148");
    flushFrame();

    expect(renders.current).toBe(trackingRenders);
  });

  it("holds both locks until the final release", () => {
    renderSurface();
    click("start");
    flushFrame();
    click("lock-first");
    click("lock-second");
    flushFrame();
    click("release-first");
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    click("release-second");
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
  });

  it("preserves the current baseline through a lock with no new scroll", () => {
    renderSurface();
    click("start");
    flushFrame();
    click("scroll-132");
    flushFrame();
    click("lock-first");
    flushFrame();
    click("release-first");
    click("scroll-140");
    click("scroll-148");
    flushFrame();

    expect(progress("AppBar")).toBe("0.125");
  });

  it("cleans queued frame, timer, and media listener on unmount", () => {
    const cancelFrame = vi.mocked(window.cancelAnimationFrame);
    const clearTimer = vi.spyOn(window, "clearTimeout");
    const view = renderSurface();
    click("start");
    flushFrame();
    click("scroll-116");
    const cancelledBeforeUnmount = cancelFrame.mock.calls.length;
    const clearedBeforeUnmount = clearTimer.mock.calls.length;

    view.unmount();

    expect(cancelFrame.mock.calls.length).toBeGreaterThan(
      cancelledBeforeUnmount,
    );
    expect(clearTimer.mock.calls.length).toBeGreaterThan(clearedBeforeUnmount);
    expect(removeMediaListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });

  it("lets source start establish the final baseline after a pane change", () => {
    renderSurface();
    click("pane-a");
    click("start");
    flushFrame();
    click("scroll-132");
    flushFrame();

    expect(progress("AppBar")).toBe("0.375");
  });

  it("resets when the active pane navigates to another route", () => {
    renderSurface();
    click("pane-a");
    click("start");
    flushFrame();
    click("scroll-132");
    flushFrame();
    expect(progress("AppBar")).toBe("0.375");

    click("pane-a-route-b");
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");
  });

  it("resets when mobile mode exits and enters", () => {
    const view = renderSurface();
    click("start");
    flushFrame();
    click("scroll-132");
    flushFrame();
    viewport.mobile = false;
    view.rerender(
      <MobileChromeProvider>
        <Surface />
      </MobileChromeProvider>,
    );
    flushFrame();
    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    viewport.mobile = true;
    view.rerender(
      <MobileChromeProvider>
        <Surface />
      </MobileChromeProvider>,
    );
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Visible");
    expect(progress("AppBar")).toBe("0");
  });

  it("pins reduced-motion readers before any scroll sample can collapse chrome", () => {
    reducedMotion = true;
    renderSurface();
    click("start");
    click("scroll-132");
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    expect(progress("AppBar")).toBe("0");
  });

  it("pins an initial reduced-motion source before its first update", () => {
    reducedMotion = true;
    renderSurface({ startOnMount: true, updateOnMount: true });
    flushFrame();

    expect(screen.getByTestId("phase")).toHaveTextContent("Pinned");
    expect(progress("AppBar")).toBe("0");
  });
});
