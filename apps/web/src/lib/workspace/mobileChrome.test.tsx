import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import {
  MobileChromeProvider,
  useMobileChrome,
} from "@/lib/workspace/mobileChrome";

// Force the provider's mobile gating on so scroll/hide behavior is active.
vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => true,
}));

const SCROLL_HEIGHT = 2000;
const CLIENT_HEIGHT = 500;

/**
 * A consumer that surfaces `hidden` as text and exposes buttons that drive the
 * provider. Each scroll button calls `onDocumentScroll` with a fixed scrollTop
 * against a stable 2000x500 viewport (maxScrollTop = 1500).
 */
function Consumer({ scrollTops }: { scrollTops: number[] }) {
  const { hidden, onDocumentScroll, acquireVisibleLock } = useMobileChrome();
  const releaseRef = useRef<null | (() => void)>(null);
  return (
    <div>
      <div data-testid="state">{hidden ? "hidden" : "visible"}</div>
      {scrollTops.map((scrollTop, index) => (
        <button
          key={index}
          type="button"
          data-testid={`scroll-${index}`}
          onClick={() =>
            onDocumentScroll({
              scrollTop,
              scrollHeight: SCROLL_HEIGHT,
              clientHeight: CLIENT_HEIGHT,
            })
          }
        >
          scroll to {scrollTop}
        </button>
      ))}
      <button
        type="button"
        data-testid="acquire-lock"
        onClick={() => {
          releaseRef.current = acquireVisibleLock("text-selection");
        }}
      >
        acquire lock
      </button>
      <button
        type="button"
        data-testid="release-lock"
        onClick={() => {
          releaseRef.current?.();
          releaseRef.current = null;
        }}
      >
        release lock
      </button>
    </div>
  );
}

function renderConsumer(scrollTops: number[]) {
  return render(
    <MobileChromeProvider>
      <Consumer scrollTops={scrollTops} />
    </MobileChromeProvider>,
  );
}

function scrollTo(index: number) {
  fireEvent.click(screen.getByTestId(`scroll-${index}`));
}

function mockReducedMotion(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(((query: string) => {
    const isReduceQuery = query === "(prefers-reduced-motion: reduce)";
    return {
      matches: isReduceQuery ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia);
}

/** Drives setPaneChrome so the pane-switch reset can be exercised. */
function PaneSwitchConsumer() {
  const { hidden, onDocumentScroll, setPaneChrome } = useMobileChrome();
  const setPane = (paneId: string) =>
    setPaneChrome({
      paneId,
      identityId: `${paneId}-identity`,
      header: {
        kind: "section",
        standingHead: paneId,
        folio: { kind: "none" },
        pending: false,
      },
      navigation: { canGoBack: false, canGoForward: false, onBack: () => {}, onForward: () => {} },
      actions: [],
      options: [],
    });
  const scroll = (scrollTop: number) =>
    onDocumentScroll({ scrollTop, scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT });
  return (
    <div>
      <div data-testid="state">{hidden ? "hidden" : "visible"}</div>
      <button type="button" data-testid="scroll-0" onClick={() => scroll(100)} />
      <button type="button" data-testid="scroll-1" onClick={() => scroll(130)} />
      <button type="button" data-testid="pane-a" onClick={() => setPane("pane-a")} />
      <button type="button" data-testid="pane-b" onClick={() => setPane("pane-b")} />
    </div>
  );
}

describe("MobileChromeProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("starts visible", () => {
    renderConsumer([]);
    expect(screen.getByTestId("state")).toHaveTextContent("visible");
  });

  it("hides after a deliberate downward scroll of >= 24px past the top zone", async () => {
    // Two downward calls: the first records the "down" direction (start = 100),
    // the second accumulates |130 - 100| = 30 >= HIDE_TOLERANCE_PX (24).
    renderConsumer([100, 130]);

    scrollTo(0);
    expect(screen.getByTestId("state")).toHaveTextContent("visible");

    scrollTo(1);
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("hidden"),
    );
  });

  it("does not hide before the down accumulation reaches 24px", async () => {
    // First call sets direction (start = 100); second accumulates only 10px (< 24).
    renderConsumer([100, 110]);

    scrollTo(0);
    scrollTo(1);

    // Give the state a chance to settle, then assert it never hid.
    await Promise.resolve();
    expect(screen.getByTestId("state")).toHaveTextContent("visible");
  });

  it("reveals after a deliberate upward scroll of >= 16px once hidden", async () => {
    // 0,1: hide (down 100 -> 130). 2: records "up" direction (start = 120).
    // 3: accumulates |100 - 120| = 20 >= REVEAL_TOLERANCE_PX (16). Still > 60.
    renderConsumer([100, 130, 120, 100]);

    scrollTo(0);
    scrollTo(1);
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("hidden"),
    );

    scrollTo(2);
    scrollTo(3);
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("visible"),
    );
  });

  it("always shows when scrollTop is within the independent top zone (<= 60)", async () => {
    // Hide first, then a scroll into the top zone (40 <= 60) forces visible.
    renderConsumer([100, 130, 40]);

    scrollTo(0);
    scrollTo(1);
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("hidden"),
    );

    scrollTo(2);
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("visible"),
    );
  });

  it("keeps the bar visible through a hide-scroll while a lock is held, then resumes hiding after release", async () => {
    // Indices 0,1 hide (100 -> 130); after release, 2,3 hide again (160 -> 190).
    renderConsumer([100, 130, 160, 190]);

    // Acquire a visible lock; bar is pinned visible.
    fireEvent.click(screen.getByTestId("acquire-lock"));
    expect(screen.getByTestId("state")).toHaveTextContent("visible");

    // A full hide-scroll must NOT hide while the lock is held.
    scrollTo(0);
    scrollTo(1);
    await Promise.resolve();
    expect(screen.getByTestId("state")).toHaveTextContent("visible");

    // Releasing all locks re-reveals the bar (showNow) and resumes normal behavior.
    fireEvent.click(screen.getByTestId("release-lock"));
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("visible"),
    );

    // A fresh deliberate downward scroll now hides again, proving behavior resumed.
    scrollTo(2);
    scrollTo(3);
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("hidden"),
    );
  });

  it("pins the bar visible under prefers-reduced-motion and never hides on scroll", async () => {
    mockReducedMotion(true);
    renderConsumer([100, 130]);

    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("visible"),
    );

    scrollTo(0);
    scrollTo(1);
    await Promise.resolve();
    expect(screen.getByTestId("state")).toHaveTextContent("visible");
  });

  it("reveals the bar again when the active pane changes", async () => {
    render(
      <MobileChromeProvider>
        <PaneSwitchConsumer />
      </MobileChromeProvider>,
    );

    fireEvent.click(screen.getByTestId("pane-a"));
    fireEvent.click(screen.getByTestId("scroll-0"));
    fireEvent.click(screen.getByTestId("scroll-1"));
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("hidden"),
    );

    // Switching panes resets the hide state so the new pane's bar starts visible.
    fireEvent.click(screen.getByTestId("pane-b"));
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("visible"),
    );
  });
});
