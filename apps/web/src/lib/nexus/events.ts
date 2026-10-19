// Nexus open ingress: the window event any module can raise, the queue that holds requests
// made before the Nexus mounts, and the one-shot `?nexus=1&intent=Root|QuickAction&action=` URL.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { NexusOpenIntent } from "./model";
import { parseNexusOpenUrl } from "./urlIntent";

const OPEN_REQUESTED = "Nexus.OpenRequested";

declare global {
  interface Window {
    __nexusOpenReceiverReady?: boolean;
    __nexusPendingOpenIntents?: NexusOpenIntent[];
  }
}

export function requestNexusOpen(intent: NexusOpenIntent): void {
  if (window.__nexusOpenReceiverReady) {
    window.dispatchEvent(new CustomEvent<NexusOpenIntent>(OPEN_REQUESTED, { detail: intent }));
  } else {
    (window.__nexusPendingOpenIntents ??= []).push(intent);
  }
}

function consumeUrlIntent(): NexusOpenIntent | null {
  const parsed = parseNexusOpenUrl(new URL(window.location.href));
  if (parsed === null) return null;
  window.history.replaceState(window.history.state, "", parsed.href);
  return parsed.intent;
}

/** The single receiver: the URL intent at mount, queued requests in order, then each event. */
export function useNexusOpenRequests(receive: (intent: NexusOpenIntent) => void, ready: boolean): void {
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  const urlIntent = useRef<NexusOpenIntent | null>(null);
  useLayoutEffect(() => {
    const intent = consumeUrlIntent();
    if (intent) urlIntent.current = intent;
  }, []);
  useEffect(() => {
    if (!ready) return;
    const listener = (event: Event) => receiveRef.current((event as CustomEvent<NexusOpenIntent>).detail);
    window.addEventListener(OPEN_REQUESTED, listener);
    window.__nexusOpenReceiverReady = true;
    if (urlIntent.current) {
      const intent = urlIntent.current;
      urlIntent.current = null;
      receiveRef.current(intent);
    }
    const pending = window.__nexusPendingOpenIntents ?? [];
    window.__nexusPendingOpenIntents = [];
    pending.forEach((intent) => receiveRef.current(intent));
    return () => {
      window.removeEventListener(OPEN_REQUESTED, listener);
      window.__nexusOpenReceiverReady = false;
    };
  }, [ready]);
}
