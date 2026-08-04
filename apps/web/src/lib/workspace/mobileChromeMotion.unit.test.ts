import { describe, expect, it } from "vitest";
import {
  COLLAPSE_TRAVEL_SCROLL_PX,
  DIRECTION_REVERSAL_DEAD_ZONE_PX,
  MIN_SCROLL_DELTA_PX,
  TOP_PINNED_SCROLL_PX,
  initialMobileChromeMotionState,
  mobileChromePresentationProgress,
  reduceMobileChromeMotion,
  type MobileChromeMotionState,
} from "@/lib/workspace/mobileChromeMotion";

// Risk: mobile reader chrome retreats, reveals, settles, and rebaselines
// against real scroll (council-plan Target behaviour table; hard-cutover AC3).
// Oracle: the locked motion thresholds published by the contract — an 8px top
// pin, an 8px direction dead zone, 64px collapse travel, a 1px delta floor, and
// midpoint-based settlement. Expected progress values below are computed from
// those constants by hand, never by snapshotting the reducer, and every
// fraction is an exact binary value (integer / 64) so float equality is safe.

const SCROLLABLE = { scrollHeight: 10_000, clientHeight: 800 } as const;

function snap(scrollTop: number) {
  return { scrollTop, ...SCROLLABLE };
}

function scrollTo(
  state: MobileChromeMotionState,
  scrollTop: number,
): MobileChromeMotionState {
  return reduceMobileChromeMotion(state, { kind: "Scroll", snapshot: snap(scrollTop) });
}

function started(scrollTop: number): MobileChromeMotionState {
  return reduceMobileChromeMotion(initialMobileChromeMotionState(), {
    kind: "Start",
    snapshot: snap(scrollTop),
  });
}

describe("mobileChromeMotion — locked thresholds", () => {
  it("publishes the contract's five motion constants", () => {
    expect(TOP_PINNED_SCROLL_PX).toBe(8);
    expect(DIRECTION_REVERSAL_DEAD_ZONE_PX).toBe(8);
    expect(COLLAPSE_TRAVEL_SCROLL_PX).toBe(64);
    expect(MIN_SCROLL_DELTA_PX).toBe(1);
  });
});

describe("mobileChromeMotion — baseline and top pin", () => {
  it("Start captures the live scroll baseline while staying fully visible", () => {
    const state = started(120);
    expect(state.phase).toEqual({ kind: "Visible" });
    expect(state.progress).toBe(0);
    expect(state.lastScrollTop).toBe(120);
    expect(state.direction).toBeNull();
  });

  it("returns to fully visible whenever the reader is within the top pin", () => {
    const hidden = scrollTo(started(200), 320);
    expect(hidden.phase).toEqual({ kind: "Hidden" });

    const atTop = scrollTo(hidden, TOP_PINNED_SCROLL_PX - 4);
    expect(atTop.phase).toEqual({ kind: "Visible" });
    expect(atTop.progress).toBe(0);
    expect(atTop.direction).toBeNull();
  });

  it("ignores sub-pixel jitter below the 1px delta floor", () => {
    const base = started(100);
    const jittered = scrollTo(base, 100 + MIN_SCROLL_DELTA_PX / 2);
    expect(jittered).toBe(base);
    expect(jittered.lastScrollTop).toBe(100);
  });
});

describe("mobileChromeMotion — forward retreat", () => {
  it("consumes the 8px dead zone then advances progress proportionally over 64px", () => {
    // delta 40 → (40 - 8) / 64 = 0.5
    const tracking = scrollTo(started(100), 140);
    expect(tracking.phase).toEqual({ kind: "Tracking", direction: "Down" });
    expect(tracking.progress).toBe(0.5);
  });

  it("reaches Hidden only after the dead zone plus a full travel (8 + 64)", () => {
    const hidden = scrollTo(started(100), 100 + DIRECTION_REVERSAL_DEAD_ZONE_PX + COLLAPSE_TRAVEL_SCROLL_PX);
    expect(hidden.phase).toEqual({ kind: "Hidden" });
    expect(hidden.progress).toBe(1);
  });

  it("charges the dead zone once across a sustained forward gesture", () => {
    // 8px (fully absorbed) then 32px more → same 0.5 as a single 40px move.
    const stepped = scrollTo(scrollTo(started(100), 108), 140);
    expect(stepped.phase).toEqual({ kind: "Tracking", direction: "Down" });
    expect(stepped.progress).toBe(0.5);
  });
});

describe("mobileChromeMotion — reverse reveal", () => {
  it("holds hidden until the reversal clears its own 8px dead zone, then reveals", () => {
    const hidden = scrollTo(started(100), 200);
    expect(hidden.phase).toEqual({ kind: "Hidden" });

    // 4px up is inside the reversal dead zone: still hidden, direction flipped.
    const withinDeadZone = scrollTo(hidden, 196);
    expect(withinDeadZone.phase).toEqual({ kind: "Hidden" });
    expect(withinDeadZone.direction).toBe("Up");

    // 16px more up → cumulative 20px up, (20 - 8) / 64 = 0.1875 revealed.
    const revealing = scrollTo(withinDeadZone, 180);
    expect(revealing.phase).toEqual({ kind: "Tracking", direction: "Up" });
    expect(revealing.progress).toBe(1 - 0.1875);
  });
});

describe("mobileChromeMotion — settlement lifecycle", () => {
  it("settles toward the nearer endpoint by the 0.5 midpoint", () => {
    const towardVisible = reduceMobileChromeMotion(scrollTo(started(100), 124), { kind: "Settle" });
    expect(towardVisible.phase).toEqual({ kind: "Settling", target: "Visible" }); // progress 0.25
    const towardHidden = reduceMobileChromeMotion(scrollTo(started(100), 156), { kind: "Settle" });
    expect(towardHidden.phase).toEqual({ kind: "Settling", target: "Hidden" }); // progress 0.75
  });

  it("does not settle from an endpoint or a pin", () => {
    const visible = started(100);
    expect(reduceMobileChromeMotion(visible, { kind: "Settle" })).toBe(visible);
    const hidden = scrollTo(started(100), 300);
    expect(reduceMobileChromeMotion(hidden, { kind: "Settle" })).toBe(hidden);
    const pinned = reduceMobileChromeMotion(visible, { kind: "Pin" });
    expect(reduceMobileChromeMotion(pinned, { kind: "Settle" })).toBe(pinned);
  });

  it("FinishSettle snaps to the resolved endpoint and is inert otherwise", () => {
    const settlingVisible = reduceMobileChromeMotion(scrollTo(started(100), 124), { kind: "Settle" });
    const visible = reduceMobileChromeMotion(settlingVisible, { kind: "FinishSettle" });
    expect(visible.phase).toEqual({ kind: "Visible" });
    expect(visible.progress).toBe(0);

    const settlingHidden = reduceMobileChromeMotion(scrollTo(started(100), 156), { kind: "Settle" });
    const hidden = reduceMobileChromeMotion(settlingHidden, { kind: "FinishSettle" });
    expect(hidden.phase).toEqual({ kind: "Hidden" });
    expect(hidden.progress).toBe(1);

    const tracking = scrollTo(started(100), 124);
    expect(reduceMobileChromeMotion(tracking, { kind: "FinishSettle" })).toBe(tracking);
  });

  it("resumes from the current progress when a new scroll interrupts settlement", () => {
    const settling = reduceMobileChromeMotion(scrollTo(started(100), 124), { kind: "Settle" });
    expect(settling.progress).toBe(0.25);
    // 32px more forward from the interrupted 0.25 → 0.25 + 0.5 = 0.75, not a restart.
    const resumed = scrollTo(settling, 156);
    expect(resumed.phase).toEqual({ kind: "Tracking", direction: "Down" });
    expect(resumed.progress).toBe(0.75);
  });

  it("snaps presentation progress to the settle target while the state keeps its live value", () => {
    const settling = reduceMobileChromeMotion(scrollTo(started(100), 124), { kind: "Settle" });
    expect(settling.progress).toBe(0.25);
    expect(mobileChromePresentationProgress(settling)).toBe(0);
    const settlingHidden = reduceMobileChromeMotion(scrollTo(started(100), 156), { kind: "Settle" });
    expect(mobileChromePresentationProgress(settlingHidden)).toBe(1);
    expect(mobileChromePresentationProgress(scrollTo(started(100), 140))).toBe(0.5);
  });
});

describe("mobileChromeMotion — geometry refresh keeps the reader's place", () => {
  const refresh = (
    state: MobileChromeMotionState,
    snapshot: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) => reduceMobileChromeMotion(state, { kind: "RefreshGeometry", snapshot });

  it("preserves collapse progress and phase when still scrollable and past the pin", () => {
    const tracking = scrollTo(started(100), 140);
    const refreshed = refresh(tracking, snap(140));
    expect(refreshed.phase).toEqual({ kind: "Tracking", direction: "Down" });
    expect(refreshed.progress).toBe(0.5);
    expect(refreshed.lastScrollTop).toBe(140);
  });

  it("reveals when the reader becomes non-scrollable or returns to the top", () => {
    const tracking = scrollTo(started(100), 140);
    const nonScrollable = refresh(tracking, { scrollTop: 140, scrollHeight: 800, clientHeight: 800 });
    expect(nonScrollable.phase).toEqual({ kind: "Visible" });
    expect(nonScrollable.progress).toBe(0);
    const atTop = refresh(tracking, snap(TOP_PINNED_SCROLL_PX - 4));
    expect(atTop.phase).toEqual({ kind: "Visible" });
  });

  it("keeps a pin through geometry refresh", () => {
    const pinned = reduceMobileChromeMotion(started(100), { kind: "Pin" });
    const refreshed = refresh(pinned, { scrollTop: 0, scrollHeight: 800, clientHeight: 800 });
    expect(refreshed.phase).toEqual({ kind: "Pinned" });
  });
});

describe("mobileChromeMotion — explicit pin", () => {
  it("Pin forces Pinned and Unpin restores Visible, both fully revealed", () => {
    const pinned = reduceMobileChromeMotion(scrollTo(started(100), 140), { kind: "Pin" });
    expect(pinned.phase).toEqual({ kind: "Pinned" });
    expect(pinned.progress).toBe(0);
    expect(pinned.direction).toBeNull();
    const unpinned = reduceMobileChromeMotion(pinned, { kind: "Unpin" });
    expect(unpinned.phase).toEqual({ kind: "Visible" });
    expect(unpinned.progress).toBe(0);
  });
});
