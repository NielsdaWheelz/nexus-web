import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchPaneSearchRequest,
  PANE_SEARCH_REQUESTED_EVENT,
  usePaneSearchRequested,
} from "./paneSearchEvents";

function Consumer({ consume }: { consume: boolean }) {
  usePaneSearchRequested(() => consume);
  return null;
}

describe("pane Search requests", () => {
  it("reports whether a mounted pane synchronously consumed the request", () => {
    const { rerender, unmount } = render(<Consumer consume={false} />);

    expect(dispatchPaneSearchRequest()).toBe(false);
    rerender(<Consumer consume />);
    expect(dispatchPaneSearchRequest()).toBe(true);
    unmount();
    expect(dispatchPaneSearchRequest()).toBe(false);
  });

  it("uses one cancelable window event with the canonical name", () => {
    const listener = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(PANE_SEARCH_REQUESTED_EVENT, listener);

    expect(dispatchPaneSearchRequest()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatchObject({
      cancelable: true,
      defaultPrevented: true,
    });

    window.removeEventListener(PANE_SEARCH_REQUESTED_EVENT, listener);
  });
});
