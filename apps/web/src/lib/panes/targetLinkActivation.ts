"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import {
  isWorkspaceSecondarySurfaceId,
  type WorkspaceSecondaryActivation,
} from "@/lib/panes/paneSecondaryModel";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import {
  beginMediaReaderViewTransition,
  clearMediaReaderViewTransition,
  startSameDocumentViewTransition,
} from "@/lib/ui/viewTransitions";

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

interface WorkspaceTargetClickIntent {
  readonly disposition: WorkspaceTargetDisposition;
  readonly modality: "Keyboard" | "Pointer";
}

export function workspaceTargetClickIntent(event: {
  readonly detail: number;
  readonly shiftKey: boolean;
}): WorkspaceTargetClickIntent {
  const modality = event.detail === 0 ? "Keyboard" : "Pointer";
  return {
    disposition: {
      kind:
        event.shiftKey && modality === "Pointer"
          ? "Fork"
          : "Follow",
    },
    modality,
  };
}

type TargetLinkMouseEvent = Pick<
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

export function activateTargetLink(input: {
  event: TargetLinkMouseEvent;
  runtime: TargetLinkActivationRuntime | null;
  href: string | null;
  labelHint?: string;
  secondaryActivation?: WorkspaceSecondaryActivation;
  sourceAnchor?: HTMLAnchorElement;
}): TargetLinkActivationResult {
  const runtime = input.runtime;
  const href = input.href?.startsWith("#")
    ? null
    : input.href && normalizeWorkspaceHref(input.href);
  if (
    !runtime ||
    !href ||
    resolvePaneRoute(href).id === "unsupported" ||
    input.event.defaultPrevented ||
    input.event.button !== 0 ||
    input.event.metaKey ||
    input.event.ctrlKey ||
    input.event.altKey
  ) {
    return "unhandled";
  }

  input.event.preventDefault();
  const { disposition } = workspaceTargetClickIntent(input.event);
  const activateTarget = () => runtime.activateTarget({
    target: {
      href,
      ...(input.labelHint ? { labelHint: input.labelHint } : {}),
      ...(input.secondaryActivation
        ? { secondaryActivation: input.secondaryActivation }
        : {}),
    },
    disposition,
  });
  const viewTransition =
    disposition.kind === "Follow" && input.sourceAnchor
      ? beginMediaReaderViewTransition(input.sourceAnchor, href)
      : undefined;
  if (viewTransition?.kind === "media-reader") {
    startSameDocumentViewTransition(activateTarget, {
      preload: () => preloadPane("media"),
      onFinish: () => clearMediaReaderViewTransition(viewTransition.mediaId),
    });
  } else {
    activateTarget();
  }
  return "handled";
}

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
  return activateTargetLink({
    event: input.event,
    runtime: input.runtime,
    href: anchor.getAttribute("href"),
    labelHint:
      anchor.dataset.paneLabelHint ||
      (anchor.getAttribute("role") === "menuitem"
        ? anchor.textContent?.trim() || undefined
        : undefined),
    secondaryActivation: secondaryActivationForAnchor(anchor) ?? undefined,
    sourceAnchor: anchor,
  });
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
