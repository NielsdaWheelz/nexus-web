// Nexus open ingress: the window event any module can raise, the queue that holds requests
// made before the Nexus mounts, and the one-shot `?nexus=1&intent=Root|QuickAction&action=` URL.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { NexusCommandId, NexusOpenIntent } from "./model";
import { NEXUS_COMMANDS } from "./query";

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
  const params = new URLSearchParams(window.location.search);
  const action = params.get("action");
  const intent = params.get("intent");
  if (
    params.getAll("nexus").join() !== "1" ||
    params.getAll("intent").length !== 1 ||
    params.has("q") ||
    params.getAll("action").length > 1
  ) {
    return null;
  }
  const parsed: NexusOpenIntent | null =
    intent === "Root" && action === null
      ? { kind: "Root" }
      : intent === "QuickAction" && action !== null && Object.hasOwn(NEXUS_COMMANDS, action)
        ? { kind: "QuickAction", actionId: action as NexusCommandId }
        : null;
  if (parsed === null) return null;
  for (const name of ["nexus", "intent", "q", "action"]) params.delete(name);
  const search = params.toString();
  const { pathname, hash } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search ? `?${search}` : ""}${hash}`);
  return parsed;
}

/** The single receiver: the URL intent at mount, queued requests in order, then each event. */
export function useNexusOpenRequests(receive: (intent: NexusOpenIntent) => void): void {
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  useLayoutEffect(() => {
    const intent = consumeUrlIntent();
    if (intent) receiveRef.current(intent);
  }, []);
  useEffect(() => {
    const listener = (event: Event) => receiveRef.current((event as CustomEvent<NexusOpenIntent>).detail);
    window.addEventListener(OPEN_REQUESTED, listener);
    window.__nexusOpenReceiverReady = true;
    const pending = window.__nexusPendingOpenIntents ?? [];
    window.__nexusPendingOpenIntents = [];
    pending.forEach((intent) => receiveRef.current(intent));
    return () => {
      window.removeEventListener(OPEN_REQUESTED, listener);
      window.__nexusOpenReceiverReady = false;
    };
  }, []);
}
