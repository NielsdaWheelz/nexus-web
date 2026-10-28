import type { FeedbackAction, FeedbackContent } from "./Feedback";
import { getBrowserViewportKind } from "@/lib/renderEnvironment/provider";
import { isTextEntryTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";

export interface Transient {
  /** One outcome across its presentations; its owner retracts it by this identity. */
  readonly id: object;
  readonly content: FeedbackContent;
  readonly action: FeedbackAction | null;
  /** One presentation; a displaced outcome returns as a new occurrence. */
  readonly occurrence: object;
  /** False once a presentation has been placed, so a returning card stays silent. */
  readonly announce: boolean;
}
const RECEIPT_MS = 5000;
const ACTION_MS = 8000;

/** account-session presentation of one discrete outcome at a time; nothing is retained.
 * a newer outcome replaces the visible one and any waiting one. any non-success outcome
 * that cannot show yet, or that a blocker displaces, waits as the single pending outcome
 * until the workspace is visible and unblocked; a success is skipped. its owner retracts
 * an outcome whose state resolved, so a waiting card never shows stale.
 * one visible-time clock runs only while the placed card is unheld.
 */
export function createTransientFeedback() {
  let current: Transient | null = null;
  let waiting: Transient | null = null;
  let active = true;
  const listeners = new Set<() => void>();
  const holds = new Set<"Pointer" | "Focus" | "Press">();
  let placed = false;
  let clock: { remaining: number; started: number | null; timer: ReturnType<typeof setTimeout> | null } | null = null;
  const commit = (next: Transient | null) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const blocked = () => hasActiveInteractionOwner()
    || (getBrowserViewportKind() === "mobile" && isTextEntryTarget(document.activeElement));
  const stopClock = () => {
    if (!clock || clock.started === null) return;
    if (clock.timer !== null) clearTimeout(clock.timer);
    clock.remaining = Math.max(0, clock.remaining - (performance.now() - clock.started));
    clock.started = null;
    clock.timer = null;
  };
  const show = (next: Transient) => {
    stopClock();
    clock = { remaining: next.action ? ACTION_MS : RECEIPT_MS, started: null, timer: null };
    placed = false;
    holds.clear();
    commit(next);
  };
  const flush = () => {
    if (!active || waiting === null || holds.size > 0 || document.hidden || blocked()) return;
    const next = waiting;
    waiting = null;
    show(next);
  };
  const clear = () => {
    stopClock();
    clock = null;
    placed = false;
    holds.clear();
    if (current) commit(null);
  };
  const runClock = () => {
    if (!active || !clock || clock.started !== null || !placed || holds.size > 0 || document.hidden) return;
    clock.started = performance.now();
    clock.timer = setTimeout(() => { clear(); flush(); }, clock.remaining);
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,
    receipt(content: FeedbackContent, action?: FeedbackAction): () => void {
      const id = {};
      const retract = () => {
        if (waiting?.id === id) waiting = null;
        if (current?.id === id) { clear(); flush(); }
      };
      if (!active) return retract;
      const next = { id, content, action: action ?? null, occurrence: {}, announce: true };
      if (holds.size === 0 && !document.hidden && !blocked()) {
        waiting = null;
        show(next);
      } else if (content.tone !== "Success") waiting = next;
      return retract;
    },
    closeTransient(occurrence: object) {
      if (current?.occurrence !== occurrence) return;
      clear();
      flush();
    },
    placement(occurrence: object, visible: boolean) {
      if (current?.occurrence !== occurrence) return;
      placed = visible;
      if (visible) runClock(); else stopClock();
    },
    hold(occurrence: object, kind: "Pointer" | "Focus" | "Press", held: boolean) {
      if (current?.occurrence !== occurrence) return;
      if (held) holds.add(kind); else holds.delete(kind);
      if (held) return stopClock();
      flush();
      runClock();
    },
    environmentChanged() {
      if (!blocked()) return flush();
      // A displaced non-success card returns once the blocker leaves, unless a newer one waits.
      if (current !== null && current.content.tone !== "Success" && waiting === null)
        waiting = { ...current, occurrence: {}, announce: current.announce && !placed };
      clear();
    },
    visibilityChanged() {
      if (document.hidden) return stopClock();
      flush();
      runClock();
    },
    resume() { active = true; runClock(); },
    dispose() { active = false; waiting = null; stopClock(); },
  };
}
