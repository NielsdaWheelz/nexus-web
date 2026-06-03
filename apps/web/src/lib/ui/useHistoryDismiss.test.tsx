import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHistoryDismiss } from "./useHistoryDismiss";

// history.pushState/back are browser globals (not internal modules), stubbed so the
// synthetic-entry bookkeeping is observable without mutating the real history stack.
describe("useHistoryDismiss", () => {
  beforeEach(() => {
    vi.spyOn(history, "pushState").mockImplementation(() => {});
    vi.spyOn(history, "back").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("pushes one entry while active and pops it when closed via UI", () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(({ active }) => useHistoryDismiss(active, onDismiss), {
      initialProps: { active: true },
    });
    expect(history.pushState).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    expect(history.back).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not push an entry while inactive", () => {
    renderHook(() => useHistoryDismiss(false, vi.fn()));
    expect(history.pushState).not.toHaveBeenCalled();
  });

  it("dismisses on the back button and does not pop again on close", () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(({ active }) => useHistoryDismiss(active, onDismiss), {
      initialProps: { active: true },
    });

    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(history.back).not.toHaveBeenCalled(); // the browser already removed our entry

    rerender({ active: false });
    expect(history.back).not.toHaveBeenCalled(); // nothing left to pop
  });
});
