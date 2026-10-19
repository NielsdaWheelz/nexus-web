"use client";

// The browser-gesture adapter: a plain click or Enter on an in-app link
// follows in its pane, shift-click/Enter forks a pane; everything else (modified
// clicks, other buttons, _blank, downloads, fragments, browser-owned paths)
// stays the browser's.
import {
  workspaceTargetActivationIntent,
  type TargetActivationEvent,
} from "@/lib/ui/targetActivation";
import type {
  WorkspacePaneEntry,
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

// `/` (the workspace entry) and what Next serves outside the catch-all (app/
// pages and handlers, metadata, public/, _next). Any other path is a pane's:
// a stale link follows in place to the unsupported pane, never a reload.
const BROWSER_OWNED_PATH =
  /^\/(?:_next|\.well-known|account|android|api|apple-icon|auth|brand|extension|forgot-password|icon\.svg|login|manifest\.webmanifest|opengraph-image|oracle-plates|pdfjs|privacy|robots\.txt|s|share|terms|version)?(?:[/?#]|$)/;

export type TargetLinkActivationResult =
  | "unhandled" | "consumed" | "handled-default" | "handled-new-pane";
export type AppNavActivationResult =
  | "unhandled"
  | "consumed"
  | "handled-source-focus"
  | "handled-destination-focus";
export interface TargetLinkActivationRuntime {
  activateTarget(input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
    entry?: WorkspacePaneEntry;
  }): void;
}

export function activateTargetLink(input: {
  event: TargetActivationEvent;
  runtime: TargetLinkActivationRuntime | null;
  target: WorkspaceTarget | null;
  entry?: WorkspacePaneEntry;
  onDefault?: () => void;
}): TargetLinkActivationResult {
  const { event, runtime } = input;
  const href =
    input.target && !input.target.href.startsWith("#")
      ? normalizeWorkspaceHref(input.target.href)
      : null;
  if (!runtime || !href || BROWSER_OWNED_PATH.test(href)) {
    return "unhandled";
  }
  const activation = workspaceTargetActivationIntent(event);
  if (activation.kind === "Unowned") return "unhandled";
  event.preventDefault();
  if (activation.kind === "Consume") return "consumed";
  if (activation.intent === "default" && input.onDefault) input.onDefault();
  else runtime.activateTarget({
    target: { ...input.target, href },
    disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" },
    entry: input.entry,
  });
  return activation.intent === "new_pane" ? "handled-new-pane" : "handled-default";
}

/** An anchor's own opt-outs and label hint, then `activateTargetLink`. */
export function activateTargetAnchor(input: {
  event: TargetActivationEvent;
  runtime: TargetLinkActivationRuntime | null;
  anchor: HTMLAnchorElement;
}): TargetLinkActivationResult {
  const { anchor } = input;
  if (
    anchor.hasAttribute("data-workspace-rich-target") ||
    anchor.getAttribute("aria-disabled") === "true" ||
    (anchor.target && anchor.target !== "_self") ||
    anchor.hasAttribute("download")
  ) {
    return "unhandled";
  }
  const href = anchor.getAttribute("href");
  return activateTargetLink({
    event: input.event,
    runtime: input.runtime,
    target: href ? { href, labelHint: anchor.dataset.paneLabelHint || undefined } : null,
  });
}
