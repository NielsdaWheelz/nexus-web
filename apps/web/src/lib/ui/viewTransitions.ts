"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type PaneViewTransitionIntent =
  | { kind: "collection-reflow" }
  | { kind: "media-reader"; mediaId: string };

type StartViewTransition = (
  callback: () => void | Promise<void>,
) => {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
};

interface ViewTransitionOptions {
  preload?: () => Promise<unknown>;
  onFinish?: () => void;
}

interface PendingMediaReaderViewTransition {
  mediaId: string;
  thumbName: string;
  titleName: string;
  cleanupSource: () => void;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MEDIA_READER_TRANSITION = "media-reader";

let pendingMediaReaderTransition: PendingMediaReaderViewTransition | null = null;
const mediaReaderListeners = new Set<() => void>();

function getStartViewTransition(): StartViewTransition | null {
  if (typeof document === "undefined") return null;
  const maybeDocument = document as Document & {
    startViewTransition?: StartViewTransition;
  };
  return typeof maybeDocument.startViewTransition === "function"
    ? maybeDocument.startViewTransition.bind(document)
    : null;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

export function canStartSameDocumentViewTransition(): boolean {
  return getStartViewTransition() !== null && !prefersReducedMotion();
}

export function startSameDocumentViewTransition(
  update: () => void | Promise<void>,
  options: ViewTransitionOptions = {},
): void {
  const startViewTransition = getStartViewTransition();
  if (!startViewTransition || prefersReducedMotion()) {
    void update();
    options.onFinish?.();
    return;
  }

  const transition = startViewTransition(async () => {
    if (options.preload) {
      await options.preload().catch(() => undefined);
    }
    let updateResult: void | Promise<void> = undefined;
    flushSync(() => {
      updateResult = update();
    });
    await updateResult;
  });

  void transition.ready.catch(() => undefined);
  void transition.updateCallbackDone.catch(() => undefined);
  void transition.finished
    .catch(() => undefined)
    .then(() => options.onFinish?.());
}

function emitMediaReaderTransitionChange(): void {
  for (const listener of mediaReaderListeners) {
    listener();
  }
}

function safeViewTransitionName(prefix: string, raw: string): string {
  return `${prefix}-${raw}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function collectionRowViewTransitionName(
  scopeId: string,
  rowId: string,
): string {
  return safeViewTransitionName("nexus-collection-row", `${scopeId}-${rowId}`);
}

export function useClientViewTransitionsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(canStartSameDocumentViewTransition());
  }, []);
  return ready;
}

function mediaReaderThumbTransitionName(mediaId: string): string {
  return safeViewTransitionName("nexus-media-reader-thumb", mediaId);
}

function mediaReaderTitleTransitionName(mediaId: string): string {
  return safeViewTransitionName("nexus-media-reader-title", mediaId);
}

export function mediaIdFromReaderHref(href: string): string | null {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  const match = /^\/media\/([^/]+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

function setTransitionName(
  element: Element | null,
  name: string,
): (() => void) | null {
  if (!(element instanceof HTMLElement)) return null;
  const previous = element.style.viewTransitionName;
  element.style.viewTransitionName = name;
  return () => {
    element.style.viewTransitionName = previous;
  };
}

export function beginMediaReaderViewTransition(
  sourceRoot: Element,
  href: string,
): PaneViewTransitionIntent | undefined {
  if (
    !(sourceRoot instanceof HTMLElement) ||
    sourceRoot.dataset.viewTransition !== MEDIA_READER_TRANSITION ||
    !canStartSameDocumentViewTransition()
  ) {
    return undefined;
  }

  const mediaId = mediaIdFromReaderHref(href);
  if (!mediaId) return undefined;

  clearMediaReaderViewTransition();

  const thumbName = mediaReaderThumbTransitionName(mediaId);
  const titleName = mediaReaderTitleTransitionName(mediaId);
  const cleanups = [
    setTransitionName(
      sourceRoot.querySelector('[data-view-transition-part="thumb"]'),
      thumbName,
    ),
    setTransitionName(
      sourceRoot.querySelector('[data-view-transition-part="title"]'),
      titleName,
    ),
  ].filter((cleanup): cleanup is () => void => cleanup !== null);

  if (cleanups.length === 0) {
    return undefined;
  }

  pendingMediaReaderTransition = {
    mediaId,
    thumbName,
    titleName,
    cleanupSource: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
  emitMediaReaderTransitionChange();

  return { kind: "media-reader", mediaId };
}

export function clearMediaReaderViewTransition(mediaId?: string): void {
  if (
    mediaId &&
    pendingMediaReaderTransition &&
    pendingMediaReaderTransition.mediaId !== mediaId
  ) {
    return;
  }
  const pending = pendingMediaReaderTransition;
  pendingMediaReaderTransition = null;
  pending?.cleanupSource();
  emitMediaReaderTransitionChange();
}

function subscribeMediaReaderTransition(listener: () => void): () => void {
  mediaReaderListeners.add(listener);
  return () => mediaReaderListeners.delete(listener);
}

function getMediaReaderTransitionSnapshot(): PendingMediaReaderViewTransition | null {
  return pendingMediaReaderTransition;
}

export function useMediaReaderViewTransition(
  mediaId: string | null,
): Pick<PendingMediaReaderViewTransition, "thumbName" | "titleName"> | null {
  const pending = useSyncExternalStore(
    subscribeMediaReaderTransition,
    getMediaReaderTransitionSnapshot,
    getMediaReaderTransitionSnapshot,
  );
  return pending && mediaId && pending.mediaId === mediaId
    ? { thumbName: pending.thumbName, titleName: pending.titleName }
    : null;
}
