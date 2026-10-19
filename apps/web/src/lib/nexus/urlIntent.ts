import type { NexusCommandId, NexusOpenIntent } from "./model";
import { NEXUS_COMMANDS } from "./query";

/** One-shot launcher intent and the pane href that remains after consuming it. */
export function parseNexusOpenUrl(url: URL): { intent: NexusOpenIntent; href: string } | null {
  const params = new URLSearchParams(url.search);
  const action = params.get("action");
  const intent = params.get("intent");
  if (params.getAll("nexus").join() !== "1" || params.getAll("intent").length !== 1
    || params.has("q") || params.getAll("action").length > 1) return null;
  const parsed: NexusOpenIntent | null = intent === "Root" && action === null
    ? { kind: "Root" }
    : intent === "QuickAction" && action !== null && Object.hasOwn(NEXUS_COMMANDS, action)
      ? { kind: "QuickAction", actionId: action as NexusCommandId }
      : null;
  if (parsed === null) return null;
  for (const name of ["nexus", "intent", "q", "action"]) params.delete(name);
  const search = params.toString();
  return { intent: parsed, href: `${url.pathname}${search ? `?${search}` : ""}${url.hash}` };
}
