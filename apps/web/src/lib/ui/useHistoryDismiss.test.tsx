import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHistoryDismiss } from "./useHistoryDismiss";

// history.pushState/replaceState/back are browser globals (not internal modules).
// We model `history.state` with a local value so the marker bookkeeping the hook
// reads (`history.state.__nexusOverlayHistory`) is observable, and stub `back`
// so the synthetic-entry pop is observable without mutating the real stack.
describe("useHistoryDismiss", () => {
  let fakeState: unknown = null;

  beforeEach(() => {
    fakeState = null;
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      fakeState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
  });
  afterEach(() => vi.restoreAllMocks());

  // The pop is deferred to a microtask so a navigating close (which replaces our
  // synthetic entry in a later effect of the same flush) can be detected; flush it.
  const flushMicrotasks = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("pushes one entry while active and pops it when closed via UI", async () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(
      ({ active }) => useHistoryDismiss(active, onDismiss, { isTopmost: true }),
      { initialProps: { active: true } },
    );
    expect(history.pushState).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not pop when the close navigated (synthetic entry was replaced)", async () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(
      ({ active }) => useHistoryDismiss(active, onDismiss, { isTopmost: true }),
      { initialProps: { active: true } },
    );
    expect(history.pushState).toHaveBeenCalledTimes(1);

    // A navigating select closes the overlay; the workspace URL sync replaces our
    // synthetic entry with the destination (clearing the marker) before the
    // deferred pop runs. Popping then would revert the navigation.
    rerender({ active: false });
    history.replaceState(null, "", "/settings/keybindings");
    await flushMicrotasks();

    expect(history.back).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not push an entry while inactive", () => {
    renderHook(() =>
      useHistoryDismiss(false, vi.fn(), { isTopmost: false }),
    );
    expect(history.pushState).not.toHaveBeenCalled();
  });

  it("dismisses on the back button and does not pop again on close", async () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(
      ({ active }) => useHistoryDismiss(active, onDismiss, { isTopmost: true }),
      { initialProps: { active: true } },
    );

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(history.back).not.toHaveBeenCalled(); // the browser already removed our entry

    rerender({ active: false });
    await flushMicrotasks();
    expect(history.back).not.toHaveBeenCalled(); // nothing left to pop
  });

  const markerSet = () =>
    (history.state as { __nexusOverlayHistory?: boolean } | null)
      ?.__nexusOverlayHistory === true;

  it("re-arms the marker on a blocked Back so a second Back cannot navigate away", () => {
    const onDismiss = vi.fn(() => "blocked" as const);
    renderHook(() =>
      useHistoryDismiss(true, onDismiss, { isTopmost: true }),
    );
    expect(history.pushState).toHaveBeenCalledTimes(1); // initial arm

    // Back: the browser pops our synthetic entry (marker gone) then fires popstate.
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(history.pushState).toHaveBeenCalledTimes(2); // re-armed
    expect(markerSet()).toBe(true);

    // A second immediate Back: pops the re-armed entry, fires popstate again.
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(history.pushState).toHaveBeenCalledTimes(3); // re-armed again → still on page
    expect(markerSet()).toBe(true);
  });

  it("does not re-arm when a Back is accepted", () => {
    const onDismiss = vi.fn(() => "accepted" as const);
    renderHook(() =>
      useHistoryDismiss(true, onDismiss, { isTopmost: true }),
    );
    expect(history.pushState).toHaveBeenCalledTimes(1);

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(history.pushState).toHaveBeenCalledTimes(1); // no re-arm
  });

  it("pops the re-armed entry when finally closed via UI after a blocked Back", async () => {
    const onDismiss = vi.fn(() => "blocked" as const);
    const { rerender } = renderHook(
      ({ active }) => useHistoryDismiss(active, onDismiss, { isTopmost: true }),
      { initialProps: { active: true } },
    );

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(history.pushState).toHaveBeenCalledTimes(2); // re-armed, marker restored

    rerender({ active: false });
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1); // the re-armed entry is popped
  });

  it("dismisses only the topmost nested overlay on each Back", () => {
    const onDismissOuter = vi.fn();
    const onDismissInner = vi.fn();
    const { rerender: rerenderOuter } = renderHook(
      ({ active, isTopmost }) =>
        useHistoryDismiss(active, onDismissOuter, { isTopmost }),
      { initialProps: { active: true, isTopmost: true } },
    );
    const { rerender: rerenderInner } = renderHook(
      ({ active, isTopmost }) =>
        useHistoryDismiss(active, onDismissInner, { isTopmost }),
      { initialProps: { active: true, isTopmost: true } },
    );
    rerenderOuter({ active: true, isTopmost: false });

    expect(history.pushState).toHaveBeenCalledTimes(1);
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismissInner).toHaveBeenCalledTimes(1);
    expect(onDismissOuter).not.toHaveBeenCalled();

    rerenderInner({ active: false, isTopmost: false });
    rerenderOuter({ active: true, isTopmost: true });
    expect(markerSet()).toBe(true);
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismissOuter).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared marker when a lower owner closes first", async () => {
    const onDismissOuter = vi.fn();
    const onDismissInner = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ outer, inner }) => {
        useHistoryDismiss(outer, onDismissOuter, { isTopmost: false });
        useHistoryDismiss(inner, onDismissInner, { isTopmost: true });
      },
      { initialProps: { outer: true, inner: true } },
    );

    rerender({ outer: false, inner: true });
    await flushMicrotasks();
    expect(markerSet()).toBe(true);
    expect(history.back).not.toHaveBeenCalled();

    unmount();
    await flushMicrotasks();
  });

  it("pops the shared marker exactly once when all owners close together", async () => {
    const { rerender } = renderHook(
      ({ outer, inner }) => {
        useHistoryDismiss(outer, vi.fn(), { isTopmost: false });
        useHistoryDismiss(inner, vi.fn(), { isTopmost: true });
      },
      { initialProps: { outer: true, inner: true } },
    );

    rerender({ outer: false, inner: false });
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1);
  });

  it("preserves one marker across an A-to-B owner handoff", async () => {
    const { rerender, unmount } = renderHook(
      ({ first, second }) => {
        useHistoryDismiss(first, vi.fn(), { isTopmost: first });
        useHistoryDismiss(second, vi.fn(), { isTopmost: second });
      },
      { initialProps: { first: true, second: false } },
    );
    expect(history.pushState).toHaveBeenCalledTimes(1);

    rerender({ first: false, second: true });
    await flushMicrotasks();
    expect(history.pushState).toHaveBeenCalledTimes(1);
    expect(history.back).not.toHaveBeenCalled();
    expect(markerSet()).toBe(true);

    unmount();
    await flushMicrotasks();
  });

  it("drains a delayed marker pop without dismissing a replacement owner", async () => {
    vi.mocked(history.back).mockImplementation(() => {
      // Model real same-document traversal: state changes only when the delayed
      // popstate arrives, after the replacement overlay has mounted.
    });
    const dismissFirst = vi.fn();
    const { rerender: rerenderFirst } = renderHook(
      ({ active }) =>
        useHistoryDismiss(active, dismissFirst, { isTopmost: true }),
      { initialProps: { active: true } },
    );
    rerenderFirst({ active: false });
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1);

    const dismissSecond = vi.fn();
    const { unmount: unmountSecond } = renderHook(() =>
      useHistoryDismiss(true, dismissSecond, { isTopmost: true }),
    );
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));

    expect(dismissSecond).not.toHaveBeenCalled();
    expect(markerSet()).toBe(true);
    expect(history.pushState).toHaveBeenCalledTimes(2);

    unmountSecond();
    await flushMicrotasks();
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  });

  it("does not traverse twice when a replacement closes before the delayed pop", async () => {
    vi.mocked(history.back).mockImplementation(() => {
      // Keep the marker observable until the browser delivers popstate.
    });
    const dismissFirst = vi.fn();
    const { rerender: rerenderFirst } = renderHook(
      ({ active }) =>
        useHistoryDismiss(active, dismissFirst, { isTopmost: true }),
      { initialProps: { active: true } },
    );

    rerenderFirst({ active: false });
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1);

    const dismissSecond = vi.fn();
    const { unmount: unmountSecond } = renderHook(() =>
      useHistoryDismiss(true, dismissSecond, { isTopmost: true }),
    );
    unmountSecond();
    await flushMicrotasks();

    expect(history.back).toHaveBeenCalledTimes(1);
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(dismissFirst).not.toHaveBeenCalled();
    expect(dismissSecond).not.toHaveBeenCalled();
    expect(history.back).toHaveBeenCalledTimes(1);
    expect(markerSet()).toBe(false);
  });
});
