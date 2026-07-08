import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttentionTracker } from "./useAttentionTracker";

// A controllable requestAnimationFrame: capture the pending callback and drive
// timestamps by hand so dwell accrual is deterministic.
let rafCallback: FrameRequestCallback | null = null;
let visibility: DocumentVisibilityState = "visible";
let focused = true;

function frame(timestamp: number) {
  const cb = rafCallback;
  rafCallback = null;
  act(() => {
    cb?.(timestamp);
  });
}

beforeEach(() => {
  visibility = "visible";
  focused = true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallback = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = null;
});

describe("useAttentionTracker", () => {
  it("accumulates dwell only while visible and focused", () => {
    const { result } = renderHook(() => useAttentionTracker({ mediaId: "m1" }));

    frame(1000); // first active frame anchors, no delta yet
    frame(1200); // +200
    expect(result.current.dwellDeltaRef.current).toBe(200);

    focused = false;
    frame(1400); // blurred: no accrual, anchor dropped
    expect(result.current.dwellDeltaRef.current).toBe(200);

    focused = true;
    frame(1600); // re-anchors on resume, no delta
    frame(1800); // +200
    expect(result.current.dwellDeltaRef.current).toBe(400);
  });

  it("pauses accrual while the tab is hidden and resumes when visible", () => {
    const { result } = renderHook(() => useAttentionTracker({ mediaId: "m1b" }));

    frame(1000);
    frame(1200);
    expect(result.current.dwellDeltaRef.current).toBe(200);

    visibility = "hidden";
    frame(1500);
    expect(result.current.dwellDeltaRef.current).toBe(200);

    visibility = "visible";
    frame(1700); // re-anchor
    frame(1900); // +200
    expect(result.current.dwellDeltaRef.current).toBe(400);
  });

  it("gives a second tracker for the same media id a no-op that never accumulates", () => {
    const { result: firstResult, unmount: unmountFirst } = renderHook(() =>
      useAttentionTracker({ mediaId: "shared" }),
    );
    const { result: secondResult, unmount: unmountSecond } = renderHook(() =>
      useAttentionTracker({ mediaId: "shared" }),
    );

    frame(1000);
    frame(1200);

    expect(firstResult.current.dwellDeltaRef.current).toBe(200);
    expect(secondResult.current.dwellDeltaRef.current).toBe(0);

    unmountFirst();
    unmountSecond();
  });

  it("resetDelta zeroes the ref and cleanup frees the singleton lock", () => {
    const { result: ownerResult, unmount: unmountOwner } = renderHook(() =>
      useAttentionTracker({ mediaId: "m2" }),
    );

    frame(1000);
    frame(1200);
    expect(ownerResult.current.dwellDeltaRef.current).toBe(200);

    act(() => {
      ownerResult.current.resetDelta();
    });
    expect(ownerResult.current.dwellDeltaRef.current).toBe(0);

    unmountOwner();

    // With the lock freed, a fresh mount for the same media id becomes owner.
    const { result: nextResult, unmount: unmountNext } = renderHook(() =>
      useAttentionTracker({ mediaId: "m2" }),
    );
    frame(2000);
    frame(2200);
    expect(nextResult.current.dwellDeltaRef.current).toBe(200);
    unmountNext();
  });
});
