"use client";

import { createWindowEventChannel } from "@/lib/windowEventChannel";

export const PANE_SEARCH_REQUESTED_EVENT = "Pane.SearchRequested";

const paneSearchRequestChannel = createWindowEventChannel<null>({
  eventName: PANE_SEARCH_REQUESTED_EVENT,
  cancelable: true,
});

export function dispatchPaneSearchRequest(): boolean {
  return paneSearchRequestChannel.dispatch(null);
}

export function usePaneSearchRequested(
  handler: () => boolean,
): void {
  paneSearchRequestChannel.useSubscribe(handler);
}
