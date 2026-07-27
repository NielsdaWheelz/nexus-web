"use client";

import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import {
  isWorkspaceSecondarySurfaceId,
  type WorkspaceSecondaryActivation,
} from "@/lib/panes/paneSecondaryModel";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";
import { normalizePaneLabel } from "@/lib/workspace/schema";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import { isRecord } from "@/lib/validation";

export const WORKSPACE_TARGET_ACTIVATION_EVENT =
  "nexus:workspace-target-activation";
const WORKSPACE_TARGET_ACTIVATION_MESSAGE_TYPE =
  "nexus:workspace-target-activation";
const WORKSPACE_TARGET_ACTIVATION_RECEIVER_READY_KEY =
  "__nexusWorkspaceTargetActivationReceiverReady";
const PENDING_WORKSPACE_TARGET_ACTIVATION_QUEUE_KEY =
  "__nexusPendingWorkspaceTargetActivationQueue";

declare global {
  interface Window {
    [WORKSPACE_TARGET_ACTIVATION_RECEIVER_READY_KEY]?: boolean;
    [PENDING_WORKSPACE_TARGET_ACTIVATION_QUEUE_KEY]?: WorkspaceTargetActivationIngressRequest[];
  }
}

export interface WorkspaceTargetActivationIngressRequest {
  readonly target: WorkspaceTarget;
  readonly disposition: WorkspaceTargetDisposition;
  readonly modality: PaneNavigationModality;
}

interface WorkspaceTargetActivationIngressMessage
  extends WorkspaceTargetActivationIngressRequest {
  readonly type: typeof WORKSPACE_TARGET_ACTIVATION_MESSAGE_TYPE;
}

function paneWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function parseSecondaryActivation(value: unknown): WorkspaceSecondaryActivation | null {
  if (!isRecord(value) || !isWorkspaceSecondarySurfaceId(value.surfaceId)) {
    return null;
  }
  if (value.kind === "Surface" && hasExactKeys(value, ["kind", "surfaceId"])) {
    return { kind: "Surface", surfaceId: value.surfaceId };
  }
  if (
    value.kind === "DossierCurrent" &&
    value.surfaceId === "resource-dossier" &&
    hasExactKeys(value, ["kind", "surfaceId"])
  ) {
    return { kind: "DossierCurrent", surfaceId: "resource-dossier" };
  }
  if (
    value.kind === "DossierRevision" &&
    value.surfaceId === "resource-dossier" &&
    typeof value.revisionRef === "string" &&
    value.revisionRef.startsWith("artifact_revision:") &&
    hasExactKeys(value, ["kind", "surfaceId", "revisionRef"])
  ) {
    return {
      kind: "DossierRevision",
      surfaceId: "resource-dossier",
      revisionRef: value.revisionRef,
    };
  }
  return null;
}

function parseTarget(value: unknown): WorkspaceTarget | null {
  if (!isRecord(value) || typeof value.href !== "string") {
    return null;
  }
  const targetKeys = value.secondaryActivation === undefined
    ? value.labelHint === undefined
      ? ["href"]
      : ["href", "labelHint"]
    : value.labelHint === undefined
      ? ["href", "secondaryActivation"]
      : ["href", "labelHint", "secondaryActivation"];
  if (!hasExactKeys(value, targetKeys)) {
    return null;
  }
  if (value.labelHint !== undefined && typeof value.labelHint !== "string") {
    return null;
  }
  const href = normalizeWorkspaceHref(value.href);
  if (!href || resolvePaneRoute(href).id === "unsupported") {
    return null;
  }
  const labelHint = value.labelHint === undefined
    ? undefined
    : normalizePaneLabel(value.labelHint);
  if (value.labelHint !== undefined && !labelHint) {
    return null;
  }
  const secondaryActivation = value.secondaryActivation === undefined
    ? undefined
    : parseSecondaryActivation(value.secondaryActivation);
  if (value.secondaryActivation !== undefined && !secondaryActivation) {
    return null;
  }
  return {
    href,
    ...(labelHint ? { labelHint } : {}),
    ...(secondaryActivation ? { secondaryActivation } : {}),
  };
}

function parseDisposition(value: unknown): WorkspaceTargetDisposition | null {
  if (!isRecord(value) || !hasExactKeys(value, ["kind"])) {
    return null;
  }
  switch (value.kind) {
    case "Follow":
      return { kind: "Follow" };
    case "Fork":
      return { kind: "Fork" };
    case "Adopt":
      return { kind: "Adopt" };
    default:
      return null;
  }
}

export function parseWorkspaceTargetActivationIngressRequest(
  value: unknown,
): WorkspaceTargetActivationIngressRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["target", "disposition", "modality"])
  ) {
    return null;
  }
  const target = parseTarget(value.target);
  const disposition = parseDisposition(value.disposition);
  if (
    !target ||
    !disposition ||
    (value.modality !== "Keyboard" &&
      value.modality !== "Pointer" &&
      value.modality !== "Programmatic")
  ) {
    return null;
  }
  return { target, disposition, modality: value.modality };
}

export function parseWorkspaceTargetActivationMessage(
  value: unknown,
): WorkspaceTargetActivationIngressRequest | null {
  if (
    !isRecord(value) ||
    value.type !== WORKSPACE_TARGET_ACTIVATION_MESSAGE_TYPE
  ) {
    return null;
  }
  const { type: _type, ...request } = value;
  return parseWorkspaceTargetActivationIngressRequest(request);
}

export function parseWorkspaceTargetActivationEvent(
  event: Event,
): WorkspaceTargetActivationIngressRequest | null {
  if (
    event.type !== WORKSPACE_TARGET_ACTIVATION_EVENT ||
    !(event instanceof CustomEvent)
  ) {
    return null;
  }
  return parseWorkspaceTargetActivationIngressRequest(event.detail);
}

export function setWorkspaceTargetActivationReceiverReady(ready: boolean): void {
  const currentWindow = paneWindow();
  if (currentWindow) {
    currentWindow[WORKSPACE_TARGET_ACTIVATION_RECEIVER_READY_KEY] = ready;
  }
}

export function consumePendingWorkspaceTargetActivationRequests(): WorkspaceTargetActivationIngressRequest[] {
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return [];
  }
  const requests = (currentWindow[PENDING_WORKSPACE_TARGET_ACTIVATION_QUEUE_KEY] ?? [])
    .map(parseWorkspaceTargetActivationIngressRequest)
    .filter((request): request is WorkspaceTargetActivationIngressRequest => Boolean(request));
  currentWindow[PENDING_WORKSPACE_TARGET_ACTIVATION_QUEUE_KEY] = [];
  return requests;
}

export function requestWorkspaceTargetActivation(
  request: WorkspaceTargetActivationIngressRequest,
): boolean {
  const accepted = parseWorkspaceTargetActivationIngressRequest(request);
  if (!accepted) {
    return false;
  }
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return false;
  }
  if (currentWindow.parent && currentWindow.parent !== currentWindow) {
    currentWindow.parent.postMessage(
      { type: WORKSPACE_TARGET_ACTIVATION_MESSAGE_TYPE, ...accepted } satisfies WorkspaceTargetActivationIngressMessage,
      currentWindow.location.origin,
    );
    return true;
  }
  if (!currentWindow[WORKSPACE_TARGET_ACTIVATION_RECEIVER_READY_KEY]) {
    const queue = currentWindow[PENDING_WORKSPACE_TARGET_ACTIVATION_QUEUE_KEY] ?? [];
    queue.push(accepted);
    currentWindow[PENDING_WORKSPACE_TARGET_ACTIVATION_QUEUE_KEY] = queue;
    return true;
  }
  currentWindow.dispatchEvent(
    new CustomEvent<WorkspaceTargetActivationIngressRequest>(
      WORKSPACE_TARGET_ACTIVATION_EVENT,
      { detail: accepted },
    ),
  );
  return true;
}
