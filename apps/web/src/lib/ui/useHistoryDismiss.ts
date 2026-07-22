"use client";

import { useLayoutEffect, useRef } from "react";
import { isRecord } from "@/lib/validation";

/**
 * While any owner is active, keep one synthetic history entry so Android/browser
 * Back dismisses the topmost eligible overlay instead of leaving the page. The
 * activation-ordered owner stack, marker, and popstate listener are shared across
 * all hook instances; nested, simultaneous, non-LIFO, and A-to-B handoff closes
 * therefore cannot strand entries or dismiss more than one layer.
 *
 * Dirty guard: `onDismiss` may return a `DismissDecision`. `"accepted"` (or
 * `void`) dismisses as before. `"blocked"` keeps the overlay open — because the
 * browser already popped the marker when it fired popstate, the shared owner
 * re-arms it before another Back can leave while confirmation remains visible.
 * Keep the hook mounted across open/close and drive it with `active`.
 */

export type DismissDecision = "accepted" | "blocked";

const MARKER = "__nexusOverlayHistory";

interface HistoryDismissOwner {
  readonly token: object;
  readonly onDismissRef: { current: () => DismissDecision | void };
  readonly isTopmostRef: { current: boolean };
}

const owners: HistoryDismissOwner[] = [];
let markerPopScheduled = false;
let markerPopInFlight = false;
let listening = false;

function hasMarker(): boolean {
  return isRecord(history.state) && history.state[MARKER] === true;
}

function pushMarker(): void {
  history.pushState(
    { ...(isRecord(history.state) ? history.state : {}), [MARKER]: true },
    "",
  );
}

function scheduleMarkerPop(): void {
  if (markerPopScheduled || markerPopInFlight) return;
  markerPopScheduled = true;
  queueMicrotask(() => {
    markerPopScheduled = false;
    if (markerPopInFlight) return;
    if (owners.length !== 0) return;
    if (!hasMarker()) {
      if (!markerPopInFlight) stopListening();
      return;
    }
    markerPopInFlight = true;
    startListening();
    history.back();
  });
}

function topmostOwner(): HistoryDismissOwner | null {
  for (let index = owners.length - 1; index >= 0; index -= 1) {
    const owner = owners[index];
    if (owner?.isTopmostRef.current) return owner;
  }
  return null;
}

function handlePopState(): void {
  // A UI close removes the shared marker with an asynchronous traversal. A new
  // owner can mount before that traversal completes; consume the old pop and
  // arm a fresh marker instead of dismissing the replacement overlay.
  if (markerPopInFlight) {
    markerPopInFlight = false;
    if (owners.length > 0 && !hasMarker()) pushMarker();
    if (owners.length === 0) stopListening();
    return;
  }
  const owner = topmostOwner();
  if (!owner) {
    if (owners.length > 0 && !hasMarker()) pushMarker();
    return;
  }

  const decision = owner.onDismissRef.current();
  if (decision === "blocked") {
    if (!hasMarker()) pushMarker();
    return;
  }

  // React may not commit the accepted dismissal until this native event has
  // returned. Re-arm only if a history-enabled owner remains after that commit.
  queueMicrotask(() => {
    if (owners.length > 0 && !hasMarker()) pushMarker();
  });
}

function startListening(): void {
  if (listening) return;
  window.addEventListener("popstate", handlePopState);
  listening = true;
}

function stopListening(): void {
  if (!listening) return;
  window.removeEventListener("popstate", handlePopState);
  listening = false;
}

export function useHistoryDismiss(
  active: boolean,
  onDismiss: () => DismissDecision | void,
  options: { readonly isTopmost: boolean },
): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const isTopmostRef = useRef(options.isTopmost);
  isTopmostRef.current = options.isTopmost;
  const tokenRef = useRef<object | null>(null);
  if (tokenRef.current === null) tokenRef.current = {};
  const token = tokenRef.current;

  useLayoutEffect(() => {
    if (!active) return;
    const owner = { token, onDismissRef, isTopmostRef };
    owners.push(owner);
    if (owners.length === 1) {
      // Test doubles may model traversal synchronously without a popstate. In a
      // browser, history state and popstate complete in one traversal task.
      if (markerPopInFlight && !hasMarker()) markerPopInFlight = false;
      if (!markerPopInFlight && !hasMarker()) pushMarker();
      startListening();
    }
    return () => {
      const index = owners.findIndex((candidate) => candidate.token === token);
      if (index < 0) {
        throw new Error("Active history-dismiss owner was not registered.");
      }
      owners.splice(index, 1);
      if (owners.length === 0) {
        scheduleMarkerPop();
      } else if (!markerPopInFlight && !hasMarker()) {
        pushMarker();
      }
    };
  }, [active, token]);
}
