import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionRefresher from "./SessionRefresher";

// The timer fires at 40min + up to 5min jitter; advancing past the upper bound
// guarantees exactly one scheduled tick regardless of the random jitter.
const PAST_FIRST_TICK_MS = 46 * 60 * 1000;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

function deferredResponse() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const respond = vi.fn(async () => {
    await ready;
    return new Response(null, { status: 204 });
  });
  return { respond, release };
}

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

describe("SessionRefresher", () => {
  it("posts to /auth/refresh once the jittered timer elapses", () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.useFakeTimers();

    render(<SessionRefresher />);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(PAST_FIRST_TICK_MS);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/auth/refresh", { method: "POST" });
  });

  it("refreshes when the tab becomes visible", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(<SessionRefresher />);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/auth/refresh", { method: "POST" });
  });

  it("does not refresh when the tab is hidden", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(<SessionRefresher />);

    setVisibility("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never overlaps refreshes while one is in flight", async () => {
    const { respond, release } = deferredResponse();
    vi.spyOn(globalThis, "fetch").mockImplementation(respond);

    render(<SessionRefresher />);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));

    // A second resume while the first request is still pending is dropped.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(respond).toHaveBeenCalledTimes(1);

    // Once it settles, a later resume is allowed through.
    await act(async () => {
      release();
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  });

  it("stops the timer and visibility listener after unmount", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.useFakeTimers();

    const { unmount } = render(<SessionRefresher />);
    unmount();

    act(() => {
      vi.advanceTimersByTime(PAST_FIRST_TICK_MS);
    });
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
