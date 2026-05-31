"use client";

import { isRecord } from "@/lib/validation";
import { normalizePaneTitle } from "@/lib/workspace/schema";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export const NEXUS_OPEN_PANE_EVENT = "nexus:open-pane";
const NEXUS_OPEN_PANE_MESSAGE_TYPE = "nexus:open-pane";
const NEXUS_PANE_GRAPH_READY_KEY = "__nexusPaneGraphReady";
const NEXUS_PENDING_PANE_OPEN_QUEUE_KEY = "__nexusPendingPaneOpenQueue";

declare global {
  interface Window {
    [NEXUS_PANE_GRAPH_READY_KEY]?: boolean;
    [NEXUS_PENDING_PANE_OPEN_QUEUE_KEY]?: OpenInAppPaneDetail[];
  }
}

export interface OpenInAppPaneDetail {
  href: string;
  titleHint?: string;
}

interface OpenInAppPaneMessage {
  type: typeof NEXUS_OPEN_PANE_MESSAGE_TYPE;
  href: string;
  titleHint?: string;
}

function paneWindow(): Window | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window;
}

function isPaneGraphReady(): boolean {
  return paneWindow()?.[NEXUS_PANE_GRAPH_READY_KEY] === true;
}

function sanitizeOpenPaneDetail(detail: unknown): OpenInAppPaneDetail | null {
  if (!isRecord(detail)) {
    return null;
  }
  if (typeof detail.href !== "string") {
    return null;
  }
  const href = normalizeWorkspaceHref(detail.href);
  if (!href) {
    return null;
  }
  return {
    href,
    titleHint:
      typeof detail.titleHint === "string"
        ? normalizePaneTitle(detail.titleHint) ?? undefined
        : undefined,
  };
}

function enqueuePendingPaneOpen(detail: OpenInAppPaneDetail): void {
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return;
  }
  const sanitized = sanitizeOpenPaneDetail(detail);
  if (!sanitized) {
    return;
  }
  const queue = currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] ?? [];
  queue.push(sanitized);
  currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] = queue;
}

export function setPaneGraphReady(ready: boolean): void {
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return;
  }
  currentWindow[NEXUS_PANE_GRAPH_READY_KEY] = ready;
}

export function consumePendingPaneOpenQueue(): OpenInAppPaneDetail[] {
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return [];
  }
  const queued = (currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] ?? [])
    .map((item) => sanitizeOpenPaneDetail(item))
    .filter((item): item is OpenInAppPaneDetail => Boolean(item));
  currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] = [];
  return queued;
}

export function parseOpenInAppPaneMessage(value: unknown): OpenInAppPaneDetail | null {
  if (!isRecord(value) || value.type !== NEXUS_OPEN_PANE_MESSAGE_TYPE) {
    return null;
  }
  return sanitizeOpenPaneDetail(value);
}

export function parseOpenInAppPaneEvent(event: Event): OpenInAppPaneDetail | null {
  if (event.type !== NEXUS_OPEN_PANE_EVENT || !(event instanceof CustomEvent)) {
    return null;
  }
  return sanitizeOpenPaneDetail(event.detail);
}

export function requestOpenInAppPane(href: string, options?: { titleHint?: string }): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const detail = sanitizeOpenPaneDetail({
    href,
    titleHint: options?.titleHint,
  });
  if (!detail) {
    return false;
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      {
        type: NEXUS_OPEN_PANE_MESSAGE_TYPE,
        href: detail.href,
        titleHint: detail.titleHint,
      } satisfies OpenInAppPaneMessage,
      window.location.origin
    );
    return true;
  }

  if (!isPaneGraphReady()) {
    enqueuePendingPaneOpen(detail);
    return true;
  }

  window.dispatchEvent(
    new CustomEvent<OpenInAppPaneDetail>(NEXUS_OPEN_PANE_EVENT, {
      detail,
    })
  );
  return true;
}
