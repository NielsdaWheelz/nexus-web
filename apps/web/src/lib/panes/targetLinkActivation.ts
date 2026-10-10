"use client";

// The browser-gesture adapter: a plain click or Enter on an in-app link
// follows in its pane, shift+click forks a pane; everything else (modified
// clicks, other buttons, _blank, downloads, fragments, browser-owned paths)
// stays the browser's.
import type { MouseEvent as ReactMouseEvent } from "react";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import {
  beginMediaReaderViewTransition,
  clearMediaReaderViewTransition,
  startSameDocumentViewTransition,
} from "@/lib/ui/viewTransitions";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

// `/` (the workspace entry) and what Next serves outside the catch-all (app/
// pages and handlers, metadata, public/, _next). Any other path is a pane's:
// a stale link follows in place to the unsupported pane, never a reload.
const BROWSER_OWNED_PATH =
  /^\/(?:_next|\.well-known|account|android|api|apple-icon|auth|brand|extension|forgot-password|icon\.svg|login|manifest\.webmanifest|opengraph-image|oracle-plates|pdfjs|privacy|robots\.txt|s|share|terms|version)?(?:[/?#]|$)/;

export type TargetLinkActivationResult = "unhandled" | "handled";
export type AppNavActivationResult =
  | "unhandled"
  | "handled-source-focus"
  | "handled-destination-focus";
export interface TargetLinkActivationRuntime {
  activateTarget(input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }): void;
}
export type TargetLinkMouseEvent = Pick<
  ReactMouseEvent,
  | "altKey"
  | "button"
  | "ctrlKey"
  | "defaultPrevented"
  | "detail"
  | "metaKey"
  | "preventDefault"
  | "shiftKey"
>;

/** Shift forks only for a pointer click (`detail` 0 is a keyboard click). */
export function workspaceTargetClickIntent(event: {
  readonly detail: number;
  readonly shiftKey: boolean;
}): { disposition: WorkspaceTargetDisposition } {
  const fork = event.shiftKey && event.detail > 0;
  return { disposition: { kind: fork ? "Fork" : "Follow" } };
}

export function activateTargetLink(input: {
  event: TargetLinkMouseEvent;
  runtime: TargetLinkActivationRuntime | null;
  href: string | null;
  labelHint?: string;
  sourceAnchor?: HTMLAnchorElement;
}): TargetLinkActivationResult {
  const { event, runtime } = input;
  const href =
    input.href && !input.href.startsWith("#")
      ? normalizeWorkspaceHref(input.href)
      : null;
  if (
    !runtime ||
    !href ||
    BROWSER_OWNED_PATH.test(href) ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return "unhandled";
  }
  event.preventDefault();
  const { disposition } = workspaceTargetClickIntent(event);
  const target = input.labelHint ? { href, labelHint: input.labelHint } : { href };
  const activate = () => runtime.activateTarget({ target, disposition });
  const transition =
    disposition.kind === "Follow" && input.sourceAnchor
      ? beginMediaReaderViewTransition(input.sourceAnchor, href)
      : undefined;
  if (transition?.kind === "media-reader") {
    startSameDocumentViewTransition(activate, {
      preload: () => preloadPane("media"),
      onFinish: () => clearMediaReaderViewTransition(transition.mediaId),
    });
  } else {
    activate();
  }
  return "handled";
}

/** An anchor's own opt-outs and label hint, then `activateTargetLink`. */
export function activateTargetAnchor(input: {
  event: TargetLinkMouseEvent;
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
  const menuText =
    anchor.getAttribute("role") === "menuitem"
      ? anchor.textContent?.trim()
      : undefined;
  return activateTargetLink({
    event: input.event,
    runtime: input.runtime,
    href: anchor.getAttribute("href"),
    labelHint: anchor.dataset.paneLabelHint || menuText || undefined,
    sourceAnchor: anchor,
  });
}
