import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

const originalInnerHeight = window.innerHeight;

/**
 * Sets up a fake visualViewport on window. Returns the fake viewport object so
 * callers can mutate its properties and dispatch events.
 */
function installFakeViewport(height: number, offsetTop: number) {
  const vv = new EventTarget() as EventTarget & {
    height: number;
    offsetTop: number;
  };
  vv.height = height;
  vv.offsetTop = offsetTop;
  Object.defineProperty(window, "visualViewport", {
    value: vv,
    configurable: true,
  });
  return vv;
}

describe("useKeyboardInset", () => {
  afterEach(() => {
    // Remove our fake viewport so each test starts from a clean slate.
    // Chromium's own visualViewport will be restored on the next property read
    // since we used configurable: true.
    Reflect.deleteProperty(window, "visualViewport");
    Object.defineProperty(window, "innerHeight", {
      value: originalInnerHeight,
      configurable: true,
    });
  });

  it("returns the thresholded bottom inset and raw top offset when the keyboard is open", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    installFakeViewport(500, 40);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toEqual({
      keyboardBottomInsetPx: 260,
      visualViewportTopPx: 40,
    });
  });

  it("updates when the visualViewport fires a resize event", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    const vv = installFakeViewport(500, 0);

    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current.keyboardBottomInsetPx).toBe(300);

    act(() => {
      vv.height = 300;
      vv.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toEqual({
      keyboardBottomInsetPx: 500,
      visualViewportTopPx: 0,
    });
  });

  it("updates both values when visualViewport pan fires a scroll event", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    const vv = installFakeViewport(500, 20);

    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toEqual({
      keyboardBottomInsetPx: 280,
      visualViewportTopPx: 20,
    });

    act(() => {
      vv.offsetTop = 100;
      vv.dispatchEvent(new Event("scroll"));
    });

    expect(result.current).toEqual({
      keyboardBottomInsetPx: 200,
      visualViewportTopPx: 100,
    });
  });

  it("reports 0 for measured insets just below the threshold (browser-chrome noise)", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    // 800 - 741 - 0 = 59, one below KEYBOARD_INSET_THRESHOLD_PX
    installFakeViewport(741, 0);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current.keyboardBottomInsetPx).toBe(0);
  });

  it("reports the measured inset at exactly the threshold", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    // 800 - 740 - 0 = 60 = KEYBOARD_INSET_THRESHOLD_PX
    installFakeViewport(740, 0);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current.keyboardBottomInsetPx).toBe(60);
  });

  it("reports 0 for stale visualViewport residue after keyboard close (WebKit bug 297779)", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    const vv = installFakeViewport(500, 0);

    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current.keyboardBottomInsetPx).toBe(300);

    act(() => {
      // Keyboard closed but visualViewport.height stays ~24px stale (iOS 26.0).
      vv.height = 776;
      vv.dispatchEvent(new Event("resize"));
    });

    expect(result.current.keyboardBottomInsetPx).toBe(0);
  });

  it("clamps to 0 when the formula would go negative (keyboard inset cannot be negative)", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 600,
      configurable: true,
    });
    // viewport.height(700) > innerHeight(600) → formula gives -100, clamped to 0
    installFakeViewport(700, 0);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current.keyboardBottomInsetPx).toBe(0);
  });

  it("does not threshold the nonnegative visual viewport top offset", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    installFakeViewport(741, 24);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toEqual({
      keyboardBottomInsetPx: 0,
      visualViewportTopPx: 24,
    });
  });

  it("derives the bottom inset from the normalized viewport top", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    installFakeViewport(500, -20);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toEqual({
      keyboardBottomInsetPx: 300,
      visualViewportTopPx: 0,
    });
  });

  it("returns zero geometry when visualViewport is unavailable", () => {
    Reflect.deleteProperty(window, "visualViewport");

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toEqual({
      keyboardBottomInsetPx: 0,
      visualViewportTopPx: 0,
    });
  });
});
