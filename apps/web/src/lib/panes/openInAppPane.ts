"use client";

export const NEXUS_OPEN_PANE_EVENT = "nexus:open-pane";
export const NEXUS_OPEN_PANE_MESSAGE_TYPE = "nexus:open-pane";
const NEXUS_PANE_GRAPH_READY_KEY = "__nexusPaneGraphReady";
const NEXUS_PENDING_PANE_OPEN_QUEUE_KEY = "__nexusPendingPaneOpenQueue";

export interface OpenInAppPaneDetail {
  href: string;
  titleHint?: string;
  resourceRef?: string;
}

export interface OpenInAppPaneMessage extends OpenInAppPaneDetail {
  type: typeof NEXUS_OPEN_PANE_MESSAGE_TYPE;
}

type PaneWindow = Window &
  Partial<{
    [NEXUS_PANE_GRAPH_READY_KEY]: boolean;
    [NEXUS_PENDING_PANE_OPEN_QUEUE_KEY]: OpenInAppPaneDetail[];
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

function normalizeTitleHint(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeResourceRef(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeOpenPaneDetail(detail: unknown): OpenInAppPaneDetail | null {
  if (typeof detail !== "object" || detail === null) {
    return null;
  }
  const candidate = detail as {
    href?: unknown;
    titleHint?: unknown;
    resourceRef?: unknown;
  };
  if (typeof candidate.href !== "string") {
    return null;
  }
  const href = normalizePaneHref(candidate.href);
  if (!href) {
    return null;
  }
  return {
    href,
    titleHint:
      typeof candidate.titleHint === "string"
        ? normalizeTitleHint(candidate.titleHint)
        : undefined,
    resourceRef:
      typeof candidate.resourceRef === "string"
        ? normalizeResourceRef(candidate.resourceRef)
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
  const candidate = value as {
    type?: unknown;
    href?: unknown;
    titleHint?: unknown;
    resourceRef?: unknown;
  };
  if (candidate.type !== NEXUS_OPEN_PANE_MESSAGE_TYPE || typeof candidate.href !== "string") {
    return false;
  }
  if (typeof candidate.titleHint !== "undefined" && typeof candidate.titleHint !== "string") {
    return false;
  }
  if (typeof candidate.resourceRef !== "undefined" && typeof candidate.resourceRef !== "string") {
    return false;
  }
  return true;
}

export function requestOpenInAppPane(
  href: string,
  options?: { titleHint?: string; resourceRef?: string }
): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const detail = sanitizeOpenPaneDetail({
    href,
    titleHint: options?.titleHint,
    resourceRef: options?.resourceRef,
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
        resourceRef: detail.resourceRef,
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
