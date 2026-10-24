// Nexus open ingress: the window event any module can raise, the queue that holds requests
// made before the Nexus mounts, and the one-shot `?nexus=1&intent=Root|QuickAction&action=` URL.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { NexusOpenIntent } from "./model";
import { parseNexusOpenUrl } from "./urlIntent";

const OPEN_REQUESTED = "Nexus.OpenRequested";
type OpenRequest = { readonly intent: NexusOpenIntent; readonly opener: HTMLElement | null };

declare global {
  interface Window {
    __nexusOpenReceiverReady?: boolean;
    __nexusPendingOpenRequests?: OpenRequest[];
  }
}

/** A retiring menu passes its stable trigger; it need not move focus before opening. */
export function requestNexusOpen(intent: NexusOpenIntent, opener: HTMLElement | null = null): void {
  const request = { intent, opener };
  if (window.__nexusOpenReceiverReady) {
    window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_REQUESTED, { detail: request }));
  } else {
    (window.__nexusPendingOpenRequests ??= []).push(request);
  }
}

function consumeUrlIntent(): NexusOpenIntent | null {
  const parsed = parseNexusOpenUrl(new URL(window.location.href));
  if (parsed === null) return null;
  window.history.replaceState(window.history.state, "", parsed.href);
  return parsed.intent;
}

/** The single receiver: the URL intent at mount, queued requests in order, then each event. */
export function useNexusOpenRequests(receive: (intent: NexusOpenIntent, opener: HTMLElement | null) => void, ready: boolean): void {
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  const urlIntent = useRef<NexusOpenIntent | null>(null);
  useLayoutEffect(() => {
    const intent = consumeUrlIntent();
    if (intent) urlIntent.current = intent;
  }, []);
  useEffect(() => {
    if (!ready) return;
    const listener = (event: Event) => {
      const { intent, opener } = (event as CustomEvent<OpenRequest>).detail;
      receiveRef.current(intent, opener);
    };
    window.addEventListener(OPEN_REQUESTED, listener);
    window.__nexusOpenReceiverReady = true;
    if (urlIntent.current) {
      const intent = urlIntent.current;
      urlIntent.current = null;
      receiveRef.current(intent, null);
    }
    const pending = window.__nexusPendingOpenRequests ?? [];
    window.__nexusPendingOpenRequests = [];
    pending.forEach(({ intent, opener }) => receiveRef.current(intent, opener));
    return () => {
      window.removeEventListener(OPEN_REQUESTED, listener);
      window.__nexusOpenReceiverReady = false;
    };
  }, [ready]);
}
