import type { NexusOpenIntent, NexusQuickActionId } from "./model";
import { QUICK_ACTION_REGISTRY } from "./quickActions";

export const NEXUS_OPEN_REQUESTED_EVENT = "Nexus.OpenRequested";

export function requestNexusOpen(intent: NexusOpenIntent): void {
  window.dispatchEvent(
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

function registeredQuickAction(
  value: string,
): value is NexusQuickActionId {
  return Object.hasOwn(QUICK_ACTION_REGISTRY, value);
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
        registeredQuickAction(action)
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
