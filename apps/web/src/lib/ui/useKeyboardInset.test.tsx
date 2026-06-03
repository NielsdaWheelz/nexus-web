import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

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
  });

  it("returns innerHeight − viewport.height − viewport.offsetTop when the keyboard is open", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    installFakeViewport(500, 0);

    const { result } = renderHook(() => useKeyboardInset());

    // 800 - 500 - 0 = 300
    expect(result.current).toBe(300);
  });

  it("updates when the visualViewport fires a resize event", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
    });
    const vv = installFakeViewport(500, 0);

    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(300);

    act(() => {
      vv.height = 300;
      vv.dispatchEvent(new Event("resize"));
    });

    // 800 - 300 - 0 = 500
    expect(result.current).toBe(500);
  });

  it("clamps to 0 when the formula would go negative (keyboard inset cannot be negative)", () => {
    Object.defineProperty(window, "innerHeight", {
      value: 600,
      configurable: true,
    });
    // viewport.height(700) > innerHeight(600) → formula gives -100, clamped to 0
    installFakeViewport(700, 0);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toBe(0);
  });
});
