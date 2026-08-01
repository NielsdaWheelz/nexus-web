import type { NexusOpenIntent } from "./model";
import { isNexusCommandId } from "./commands";

export const NEXUS_OPEN_REQUESTED_EVENT = "Nexus.OpenRequested";
const NEXUS_OPEN_RECEIVER_READY_KEY = "__nexusOpenReceiverReady";
const PENDING_NEXUS_OPEN_INTENTS_KEY = "__nexusPendingOpenIntents";

declare global {
  interface Window {
    [NEXUS_OPEN_RECEIVER_READY_KEY]?: boolean;
    [PENDING_NEXUS_OPEN_INTENTS_KEY]?: NexusOpenIntent[];
  }
}

function nexusWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

export function setNexusOpenReceiverReady(ready: boolean): void {
  const currentWindow = nexusWindow();
  if (currentWindow) {
    currentWindow[NEXUS_OPEN_RECEIVER_READY_KEY] = ready;
  }
}

export function consumePendingNexusOpenIntents(): NexusOpenIntent[] {
  const currentWindow = nexusWindow();
  if (!currentWindow) {
    return [];
  }
  const intents = currentWindow[PENDING_NEXUS_OPEN_INTENTS_KEY] ?? [];
  currentWindow[PENDING_NEXUS_OPEN_INTENTS_KEY] = [];
  return intents;
}

export function requestNexusOpen(intent: NexusOpenIntent): void {
  const currentWindow = nexusWindow();
  if (!currentWindow) {
    return;
  }
  if (!currentWindow[NEXUS_OPEN_RECEIVER_READY_KEY]) {
    const pending = currentWindow[PENDING_NEXUS_OPEN_INTENTS_KEY] ?? [];
    pending.push(intent);
    currentWindow[PENDING_NEXUS_OPEN_INTENTS_KEY] = pending;
    return;
  }
  currentWindow.dispatchEvent(
    new CustomEvent<NexusOpenIntent>(NEXUS_OPEN_REQUESTED_EVENT, {
      detail: intent,
    }),
  );
}

function singleValue(
  params: URLSearchParams,
  name: string,
): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

export function parseNexusUrlIntent(
  params: URLSearchParams,
): NexusOpenIntent | null {
  if (
    singleValue(params, "nexus") !== "1" ||
    params.getAll("intent").length !== 1 ||
    params.getAll("nexus").length !== 1 ||
    params.getAll("q").length > 1 ||
    params.getAll("action").length > 1
  ) {
    return null;
  }
  const intent = params.get("intent");
  const query = params.get("q");
  const action = params.get("action");
  switch (intent) {
    case "Root":
      return query === null && action === null ? { kind: "Root" } : null;
    case "QuickAction":
      return query === null &&
        action !== null &&
        isNexusCommandId(action)
        ? { kind: "QuickAction", actionId: action }
        : null;
    default:
      return { kind: "UnsupportedLink" };
  }
}

export function consumeNexusUrlIntent(): NexusOpenIntent | null {
  const params = new URLSearchParams(window.location.search);
  const intent = parseNexusUrlIntent(params);
  if (intent === null) return null;
  params.delete("nexus");
  params.delete("intent");
  params.delete("q");
  params.delete("action");
  const query = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
  return intent;
}
