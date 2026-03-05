"use client";

export const NEXUS_OPEN_PANE_EVENT = "nexus:open-pane";
export const NEXUS_OPEN_PANE_MESSAGE_TYPE = "nexus:open-pane";
const NEXUS_PANE_GRAPH_READY_KEY = "__nexusPaneGraphReady";
const NEXUS_PENDING_PANE_OPEN_QUEUE_KEY = "__nexusPendingPaneOpenQueue";

export interface OpenInAppPaneDetail {
  href: string;
}

export interface OpenInAppPaneMessage extends OpenInAppPaneDetail {
  type: typeof NEXUS_OPEN_PANE_MESSAGE_TYPE;
}

type PaneWindow = Window &
  Partial<{
    [NEXUS_PANE_GRAPH_READY_KEY]: boolean;
    [NEXUS_PENDING_PANE_OPEN_QUEUE_KEY]: string[];
  }>;

function paneWindow(): PaneWindow | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window as PaneWindow;
}

function isPaneGraphReady(): boolean {
  return paneWindow()?.[NEXUS_PANE_GRAPH_READY_KEY] === true;
}

function enqueuePendingPaneOpen(href: string): void {
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return;
  }
  const queue = currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] ?? [];
  queue.push(href);
  currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] = queue;
}

export function setPaneGraphReady(ready: boolean): void {
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return;
  }
  currentWindow[NEXUS_PANE_GRAPH_READY_KEY] = ready;
}

export function consumePendingPaneOpenQueue(): string[] {
  const currentWindow = paneWindow();
  if (!currentWindow) {
    return [];
  }
  const queued = currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] ?? [];
  currentWindow[NEXUS_PENDING_PANE_OPEN_QUEUE_KEY] = [];
  return queued;
}

export function normalizePaneHref(href: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const runtimeOrigin =
      window.location.origin && window.location.origin !== "null"
        ? window.location.origin
        : null;

    if (!runtimeOrigin) {
      if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href) || href.startsWith("//")) {
        return null;
      }
      const parsed = new URL(href, "http://localhost");
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    const parsed = new URL(href, runtimeOrigin);
    if (parsed.origin !== runtimeOrigin) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function isOpenInAppPaneMessage(value: unknown): value is OpenInAppPaneMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; href?: unknown };
  return candidate.type === NEXUS_OPEN_PANE_MESSAGE_TYPE && typeof candidate.href === "string";
}

export function requestOpenInAppPane(href: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const normalizedHref = normalizePaneHref(href);
  if (!normalizedHref) {
    return false;
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      {
        type: NEXUS_OPEN_PANE_MESSAGE_TYPE,
        href: normalizedHref,
      } satisfies OpenInAppPaneMessage,
      window.location.origin
    );
    return true;
  }

  if (!isPaneGraphReady()) {
    enqueuePendingPaneOpen(normalizedHref);
    return true;
  }

  window.dispatchEvent(
    new CustomEvent<OpenInAppPaneDetail>(NEXUS_OPEN_PANE_EVENT, {
      detail: { href: normalizedHref },
    })
  );
  return true;
}
