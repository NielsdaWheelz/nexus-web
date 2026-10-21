"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

function canTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    "startViewTransition" in document &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Runs `update` inside a same-document view transition when the browser has one and motion is allowed. */
export function startSameDocumentViewTransition(update: () => void): void {
  if (!canTransition()) return update();
  const transition = document.startViewTransition(() => flushSync(update));
  transition.ready.catch(() => undefined);
  transition.finished.catch(() => undefined);
}

export function collectionRowViewTransitionName(
  scopeId: string,
  rowId: string,
): string {
  return `nexus-collection-row-${scopeId}-${rowId}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  );
}

/** False on the server and the first client render, so row names never cause a hydration mismatch. */
export function useClientViewTransitionsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(canTransition()), []);
  return ready;
}
