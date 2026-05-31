"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";
import type { PaneScopedRouter } from "@/lib/panes/paneRuntime";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

type PaneLinkRuntime = {
  router: PaneScopedRouter;
  openInNewPane: (href: string, titleHint?: string) => void;
};

type PaneLinkMouseEvent = Pick<
  ReactMouseEvent,
  | "altKey"
  | "button"
  | "ctrlKey"
  | "defaultPrevented"
  | "metaKey"
  | "preventDefault"
  | "shiftKey"
>;

export function handlePaneInternalAnchorClick(
  event: PaneLinkMouseEvent,
  paneRuntime: PaneLinkRuntime | null,
  anchor: HTMLAnchorElement
): void {
  if (
    anchor.getAttribute("aria-disabled") === "true" ||
    (anchor.target && anchor.target !== "_self") ||
    anchor.hasAttribute("download")
  ) {
    return;
  }

  handlePaneInternalHrefClick(
    event,
    paneRuntime,
    anchor.getAttribute("href"),
    anchor.dataset.paneTitleHint ||
      (anchor.getAttribute("role") === "menuitem"
        ? anchor.textContent?.trim() || undefined
        : undefined)
  );
}

export function handlePaneInternalHrefClick(
  event: PaneLinkMouseEvent,
  paneRuntime: PaneLinkRuntime | null,
  href: string | null,
  titleHint?: string
): void {
  const normalizedHref = href && !href.startsWith("#") ? normalizeWorkspaceHref(href) : null;
  if (
    !paneRuntime ||
    !normalizedHref ||
    resolvePaneRoute(normalizedHref).id === "unsupported" ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return;
  }

  event.preventDefault();
  if (event.shiftKey) {
    paneRuntime.openInNewPane(normalizedHref, titleHint);
  } else {
    paneRuntime.router.push(normalizedHref, { titleHint });
  }
}
