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
    vi.spyOn(history, "back").mockImplementation(() => {});
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
    const { rerender } = renderHook(({ active }) => useHistoryDismiss(active, onDismiss), {
      initialProps: { active: true },
    });
    expect(history.pushState).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not pop when the close navigated (synthetic entry was replaced)", async () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(({ active }) => useHistoryDismiss(active, onDismiss), {
      initialProps: { active: true },
    });
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
    renderHook(() => useHistoryDismiss(false, vi.fn()));
    expect(history.pushState).not.toHaveBeenCalled();
  });

  it("dismisses on the back button and does not pop again on close", async () => {
    const onDismiss = vi.fn();
    const { rerender } = renderHook(({ active }) => useHistoryDismiss(active, onDismiss), {
      initialProps: { active: true },
    });

    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(history.back).not.toHaveBeenCalled(); // the browser already removed our entry

    rerender({ active: false });
    await flushMicrotasks();
    expect(history.back).not.toHaveBeenCalled(); // nothing left to pop
  });

  const markerSet = () =>
    (history.state as { __nexusOverlayHistory?: boolean } | null)?.__nexusOverlayHistory === true;

  it("re-arms the marker on a blocked Back so a second Back cannot navigate away", () => {
    const onDismiss = vi.fn(() => "blocked" as const);
    renderHook(() => useHistoryDismiss(true, onDismiss));
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
    renderHook(() => useHistoryDismiss(true, onDismiss));
    expect(history.pushState).toHaveBeenCalledTimes(1);

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(history.pushState).toHaveBeenCalledTimes(1); // no re-arm
  });

  it("pops the re-armed entry when finally closed via UI after a blocked Back", async () => {
    const onDismiss = vi.fn(() => "blocked" as const);
    const { rerender } = renderHook(({ active }) => useHistoryDismiss(active, onDismiss), {
      initialProps: { active: true },
    });

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(history.pushState).toHaveBeenCalledTimes(2); // re-armed, marker restored

    rerender({ active: false });
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1); // the re-armed entry is popped
  });
});
