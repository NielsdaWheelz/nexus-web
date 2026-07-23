"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import {
  isWorkspaceSecondarySurfaceId,
  type WorkspaceSecondaryActivation,
} from "@/lib/panes/paneSecondaryModel";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import type { PaneScopedRouter } from "@/lib/panes/paneRuntime";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import { beginMediaReaderViewTransition } from "@/lib/ui/viewTransitions";

type PaneLinkRuntime = {
  router: PaneScopedRouter;
  openInNewPane: (
    href: string,
    labelHint?: string,
    secondaryActivation?: WorkspaceSecondaryActivation,
  ) => void;
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
    anchor.dataset.paneLabelHint ||
      (anchor.getAttribute("role") === "menuitem"
        ? anchor.textContent?.trim() || undefined
        : undefined),
    {
      sourceAnchor: anchor,
      secondaryActivation: secondaryActivationForAnchor(anchor),
    },
  );
}

function secondaryActivationForAnchor(
  anchor: HTMLAnchorElement,
): WorkspaceSecondaryActivation | null {
  const surfaceId = anchor.dataset.paneSecondarySurface;
  if (!isWorkspaceSecondarySurfaceId(surfaceId)) {
    return null;
  }
  const activationKind = anchor.dataset.paneSecondaryActivation;
  const revisionRef = anchor.dataset.paneDossierRevision;
  if (activationKind === "DossierRevision" && revisionRef !== undefined) {
    return surfaceId === "resource-dossier"
      ? { kind: "DossierRevision", surfaceId, revisionRef }
      : null;
  }
  if (
    activationKind === "DossierCurrent" &&
    revisionRef === undefined &&
    surfaceId === "resource-dossier"
  ) {
    return { kind: "DossierCurrent", surfaceId };
  }
  return activationKind === undefined || activationKind === "Surface"
    ? { kind: "Surface", surfaceId }
    : null;
}

export function handlePaneInternalHrefClick(
  event: PaneLinkMouseEvent,
  paneRuntime: PaneLinkRuntime | null,
  href: string | null,
  labelHint?: string,
  options: {
    sourceAnchor?: HTMLAnchorElement;
    secondaryActivation?: WorkspaceSecondaryActivation | null;
  } = {},
): void {
  const normalizedHref = href && !href.startsWith("#") ? normalizeWorkspaceHref(href) : null;
  const resolvedRoute = normalizedHref ? resolvePaneRoute(normalizedHref) : null;
  if (
    !paneRuntime ||
    !normalizedHref ||
    resolvedRoute?.id === "unsupported" ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return;
  }

  event.preventDefault();
  const secondaryActivation = options.secondaryActivation ?? null;
  if (secondaryActivation) {
    paneRuntime.openInNewPane(
      normalizedHref,
      labelHint,
      secondaryActivation,
    );
  } else if (event.shiftKey) {
    paneRuntime.openInNewPane(normalizedHref, labelHint);
  } else {
    const viewTransition =
      resolvedRoute?.id === "media" && options.sourceAnchor
        ? beginMediaReaderViewTransition(options.sourceAnchor, normalizedHref)
        : undefined;
    const routerOptions = viewTransition
      ? labelHint
        ? { labelHint, viewTransition }
        : { viewTransition }
      : labelHint
        ? { labelHint }
        : undefined;
    paneRuntime.router.push(normalizedHref, routerOptions);
  }
}
