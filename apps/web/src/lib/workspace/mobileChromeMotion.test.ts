import { describe, expect, it } from "vitest";
import {
  initialMobileChromeMotionState,
  mobileChromePresentationProgress,
  reduceMobileChromeMotion,
} from "@/lib/workspace/mobileChromeMotion";

const snapshot = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 2_000,
  clientHeight: 500,
});

describe("reduceMobileChromeMotion", () => {
  it("clamps a source baseline and shows chrome at the document top", () => {
    const state = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: { scrollTop: -10, scrollHeight: 100, clientHeight: 200 },
    });
    const end = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: { scrollTop: 999, scrollHeight: 600, clientHeight: 500 },
    });

    expect(state).toMatchObject({
      phase: { kind: "Visible" },
      progress: 0,
      lastScrollTop: 0,
      direction: null,
    });
    expect(end.lastScrollTop).toBe(100);
  });

  it("uses the first source sample only as a visible baseline", () => {
    const state = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });

    expect(state).toMatchObject({
      phase: { kind: "Visible" },
      progress: 0,
      lastScrollTop: 100,
      direction: null,
    });
  });

  it("uses the first down gesture after the top baseline minus the dead zone", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(0),
    });
    const state = reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(40) });

    expect(state).toMatchObject({ phase: { kind: "Tracking", direction: "Down" }, progress: 0.5 });
  });

  it("collapses proportionally for downward scroll", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const state = reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(132) });

    expect(state).toMatchObject({ phase: { kind: "Tracking", direction: "Down" }, progress: 24 / 64 });
  });

  it("holds the reversal dead zone before revealing proportionally", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const collapsed = reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(132) });
    const insideDeadZone = reduceMobileChromeMotion(collapsed, {
      kind: "Scroll",
      snapshot: snapshot(126),
    });
    const revealed = reduceMobileChromeMotion(insideDeadZone, {
      kind: "Scroll",
      snapshot: snapshot(122),
    });

    expect(insideDeadZone).toMatchObject({
      phase: { kind: "Tracking", direction: "Up" },
      progress: 24 / 64,
      reversalDistancePx: 6,
    });
    expect(revealed.progress).toBe((24 - 2) / 64);
  });

  it("interrupts a reversal with a new direction without carrying dead-zone distance", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const collapsed = reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(132) });
    const reversingUp = reduceMobileChromeMotion(collapsed, {
      kind: "Scroll",
      snapshot: snapshot(122),
    });
    const reversingDown = reduceMobileChromeMotion(reversingUp, {
      kind: "Scroll",
      snapshot: snapshot(128),
    });
    const resumedDown = reduceMobileChromeMotion(reversingDown, {
      kind: "Scroll",
      snapshot: snapshot(132),
    });

    expect(reversingDown).toMatchObject({
      phase: { kind: "Tracking", direction: "Down" },
      progress: (24 - 2) / 64,
      reversalDistancePx: 6,
    });
    expect(resumedDown.progress).toBe(24 / 64);
  });

  it("ignores sub-pixel delta noise", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });

    expect(reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(100.5) })).toBe(started);
  });

  it("clamps at both endpoints and returns to visible chrome at the top", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const hidden = reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(300) });
    const visible = reduceMobileChromeMotion(hidden, { kind: "Scroll", snapshot: snapshot(8) });

    expect(hidden).toMatchObject({ phase: { kind: "Hidden" }, progress: 1 });
    expect(visible).toMatchObject({ phase: { kind: "Visible" }, progress: 0, lastScrollTop: 8 });
  });

  it("makes an upward reversal interactive at the visible endpoint", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const hidden = reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(300) });
    const visible = reduceMobileChromeMotion(hidden, { kind: "Scroll", snapshot: snapshot(200) });

    expect(visible).toMatchObject({
      phase: { kind: "Visible" },
      progress: 0,
    });
  });

  it("keeps chrome visible for a non-overflowing source", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: { scrollTop: 30, scrollHeight: 400, clientHeight: 500 },
    });
    const sampled = reduceMobileChromeMotion(started, {
      kind: "Scroll",
      snapshot: { scrollTop: 30, scrollHeight: 400, clientHeight: 500 },
    });

    expect(sampled).toMatchObject({
      phase: { kind: "Visible" },
      progress: 0,
      lastScrollTop: 0,
    });
  });

  it("refreshes geometry without resetting presentation and reveals a top or short reader", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const partial = reduceMobileChromeMotion(started, {
      kind: "Scroll",
      snapshot: snapshot(132),
    });
    const refreshed = reduceMobileChromeMotion(partial, {
      kind: "RefreshGeometry",
      snapshot: snapshot(500),
    });
    const short = reduceMobileChromeMotion(refreshed, {
      kind: "RefreshGeometry",
      snapshot: { scrollTop: 500, scrollHeight: 400, clientHeight: 500 },
    });

    expect(refreshed).toMatchObject({
      phase: { kind: "Tracking", direction: "Down" },
      progress: 24 / 64,
      lastScrollTop: 500,
      reversalDistancePx: 32,
    });
    expect(short).toMatchObject({
      phase: { kind: "Visible" },
      progress: 0,
      lastScrollTop: 0,
    });
  });

  it("settles partial progress to the nearest endpoint and ignores stale completion", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const partial = reduceMobileChromeMotion(started, { kind: "Scroll", snapshot: snapshot(131) });
    const settling = reduceMobileChromeMotion(partial, { kind: "Settle" });
    const visible = reduceMobileChromeMotion(settling, { kind: "FinishSettle" });

    expect(settling).toMatchObject({
      phase: { kind: "Settling", target: "Visible" },
      progress: 23 / 64,
    });
    expect(mobileChromePresentationProgress(settling)).toBe(0);
    expect(visible).toMatchObject({ phase: { kind: "Visible" }, progress: 0 });
    expect(reduceMobileChromeMotion(visible, { kind: "FinishSettle" })).toBe(visible);

    const midpoint = reduceMobileChromeMotion(started, {
      kind: "Scroll",
      snapshot: snapshot(140),
    });
    const settlingHidden = reduceMobileChromeMotion(midpoint, { kind: "Settle" });
    expect(settlingHidden.phase).toEqual({ kind: "Settling", target: "Hidden" });
    expect(mobileChromePresentationProgress(settlingHidden)).toBe(1);
    expect(
      reduceMobileChromeMotion(settlingHidden, { kind: "FinishSettle" }),
    ).toMatchObject({ phase: { kind: "Hidden" }, progress: 1 });
  });

  it("interrupts settling with a live scroll and rejects the stale completion", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const partial = reduceMobileChromeMotion(started, {
      kind: "Scroll",
      snapshot: snapshot(131),
    });
    const settling = reduceMobileChromeMotion(partial, { kind: "Settle" });
    const interrupted = reduceMobileChromeMotion(settling, {
      kind: "Scroll",
      snapshot: snapshot(139),
    });

    expect(settling.phase).toEqual({ kind: "Settling", target: "Visible" });
    expect(interrupted).toMatchObject({
      phase: { kind: "Tracking", direction: "Down" },
      progress: 31 / 64,
      lastScrollTop: 139,
    });
    expect(
      reduceMobileChromeMotion(interrupted, { kind: "FinishSettle" }),
    ).toBe(interrupted);
  });

  it("pins and unpins without losing the latest scroll baseline", () => {
    const started = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
      kind: "Start",
      snapshot: snapshot(100),
    });
    const pinned = reduceMobileChromeMotion(started, { kind: "Pin" });
    const sampledWhilePinned = reduceMobileChromeMotion(pinned, {
      kind: "Scroll",
      snapshot: snapshot(200),
    });
    const repinned = reduceMobileChromeMotion(sampledWhilePinned, { kind: "Pin" });
    const unpinned = reduceMobileChromeMotion(repinned, { kind: "Unpin" });

    expect(unpinned).toMatchObject({
      phase: { kind: "Visible" },
      progress: 0,
      lastScrollTop: 200,
      direction: null,
    });
  });
});
