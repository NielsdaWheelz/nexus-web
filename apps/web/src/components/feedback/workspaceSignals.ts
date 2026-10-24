import type {
  FeedbackAction,
  FeedbackContent,
  FeedbackOffer,
  OfferInput,
  WorkspaceCondition,
  WorkspaceNotice,
} from "./Feedback";
import { getBrowserViewportKind } from "@/lib/renderEnvironment/provider";
import { isTextEntryTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";

export interface WorkspaceSignal {
  readonly id: number;
  readonly key: string;
  readonly token: object;
  readonly kind: "Condition" | "Offer";
  readonly notice: WorkspaceNotice;
  readonly rank: number;
  readonly undo: boolean;
  readonly onDismiss: (() => void) | null;
}
export type WorkspaceTransient =
  | { readonly kind: "Receipt"; readonly content: FeedbackContent; readonly occurrence: object }
  | { readonly kind: "Attention"; readonly key: string; readonly token: object; readonly occurrence: object }
  | { readonly kind: "Undo"; readonly key: string; readonly commandKey: string; readonly occurrence: object };
interface Snapshot {
  readonly entries: readonly WorkspaceSignal[];
  readonly transient: WorkspaceTransient | null;
  readonly activity: { readonly trigger: HTMLElement } | null;
}
export const EMPTY_SIGNALS: Snapshot = { entries: [], transient: null, activity: null };
const PRIORITY = { Write: 0, Action: 1, Status: 2 };
const RECEIPT_MS = 5000;
const ACTION_MS = 8000;

export function transientAction(transient: WorkspaceTransient | null, entries: readonly WorkspaceSignal[]): FeedbackAction | null {
  if (transient?.kind !== "Undo") return null;
  const entry = entries.find((item) => item.key === transient.key);
  return !entry?.notice.content.reload
    ? entry?.notice.actions?.find((action) => action.commandKey === transient.commandKey) ?? null
    : null;
}

/** account-session presentation only; command validity and discard belong to owners.
 * a transient owns one visible-time clock; same-command promotion preserves it.
 */
export function createWorkspaceSignals() {
  let snapshot = EMPTY_SIGNALS;
  let nextId = 1;
  let active = true;
  let activityNavigated = false;
  const listeners = new Set<() => void>();
  const holds = new Set<"Pointer" | "Focus" | "Press">();
  let placed = false;
  let clock: { remaining: number; started: number | null; timer: ReturnType<typeof setTimeout> | null } | null = null;
  const commit = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const blocked = () => snapshot.activity !== null || hasActiveInteractionOwner()
    || (getBrowserViewportKind() === "mobile" && isTextEntryTarget(document.activeElement));
  const engaged = () => holds.size > 0 || transientAction(snapshot.transient, snapshot.entries)?.busy === true;
  const stopClock = () => {
    if (!clock || clock.started === null) return;
    if (clock.timer !== null) clearTimeout(clock.timer);
    clock.remaining = Math.max(0, clock.remaining - (performance.now() - clock.started));
    clock.started = null;
    clock.timer = null;
  };
  const clearTransient = () => {
    stopClock();
    clock = null;
    placed = false;
    holds.clear();
    if (snapshot.transient) commit({ ...snapshot, transient: null });
  };
  const runClock = () => {
    if (!active || !clock || clock.started !== null || !placed || engaged() || document.hidden) return;
    clock.started = performance.now();
    clock.timer = setTimeout(clearTransient, clock.remaining);
  };
  const publish = (transient: WorkspaceTransient) => {
    if (!active || document.hidden || blocked() || engaged()) return;
    stopClock();
    clock = { remaining: transient.kind === "Receipt" ? RECEIPT_MS : ACTION_MS, started: null, timer: null };
    placed = false;
    holds.clear();
    commit({ ...snapshot, transient });
  };
  const reconcile = (entries: readonly WorkspaceSignal[]) => {
    const transient = snapshot.transient;
    if (!transient || transient.kind === "Receipt") return transient;
    const current = entries.find((entry) => entry.key === transient.key);
    if (transient.kind === "Attention")
      return current?.token === transient.token && current.notice.needsAttention ? transient : null;
    return transientAction(transient, entries) ? transient : null;
  };
  const replace = (signal: WorkspaceSignal) => {
    const previous = snapshot.entries.find((entry) => entry.key === signal.key);
    const wasEngaged = engaged();
    const entries = (previous
      ? snapshot.entries.map((entry) => entry.key === signal.key ? signal : entry)
      : [...snapshot.entries, signal]).toSorted((a, b) => a.rank - b.rank || a.id - b.id);
    stopClock();
    const transient = reconcile(entries);
    if (!transient) { clock = null; placed = false; holds.clear(); }
    commit({ ...snapshot, entries, transient });
    runClock();
    if (!wasEngaged && signal.notice.needsAttention && !previous?.notice.needsAttention)
      publish({ kind: "Attention", key: signal.key, token: signal.token, occurrence: {} });
  };
  const remove = (key: string, token: object) => {
    const entries = snapshot.entries.filter((entry) => entry.key !== key || entry.token !== token);
    if (entries.length === snapshot.entries.length) return;
    stopClock();
    const transient = reconcile(entries);
    if (!transient) { clock = null; placed = false; holds.clear(); }
    commit({ ...snapshot, entries, transient });
    runClock();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    receipt(content: Pick<FeedbackContent, "tone" | "title">) {
      publish({ kind: "Receipt", content, occurrence: {} });
    },
    settleCondition({ key, content }: { key: string; content: Pick<FeedbackContent, "tone" | "title"> }) {
      if (!active) return;
      const current = snapshot.entries.find((entry) => entry.key === key && entry.kind === "Condition");
      if (current) remove(key, current.token);
      publish({ kind: "Receipt", content, occurrence: {} });
    },
    offer(input: OfferInput): FeedbackOffer {
      const { key, undo, onDismiss, ...notice } = input;
      const token = {};
      const command = undo === null ? null : notice.actions?.find((action) => action.commandKey !== undefined) ?? null;
      if (undo !== null && command?.commandKey === undefined) throw new Error("undo offer requires an explicit command key");
      if (active) {
        const old = snapshot.entries.find((entry) => entry.key === key);
        replace({ id: old?.id ?? nextId++, key, token, kind: "Offer", notice, rank: 3, undo: undo !== null, onDismiss });
        if (undo === "Invite" && command?.commandKey !== undefined)
          publish({ kind: "Undo", key, commandKey: command.commandKey, occurrence: {} });
      }
      return {
        update(next) {
          const old = snapshot.entries.find((entry) => entry.key === key && entry.token === token);
          if (active && old && old.notice !== next) replace({ ...old, notice: next });
        },
        withdraw() { if (active) remove(key, token); },
      };
    },
    condition(key: string, token: object, notice: WorkspaceCondition | null) {
      if (notice === null) return remove(key, token);
      const old = snapshot.entries.find((entry) => entry.key === key);
      if (old?.kind === "Condition" && old.token === token && old.notice === notice) return;
      // hook registrations may replay before the provider's strict-mode setup.
      replace({ id: old?.id ?? nextId++, key, token, kind: "Condition", notice, rank: PRIORITY[notice.priority], undo: false, onDismiss: null });
    },
    withdrawCondition: remove,
    dismiss(entry: WorkspaceSignal) {
      if (!active) return;
      const current = snapshot.entries.find((item) => item.key === entry.key && item.token === entry.token);
      if (current?.kind !== "Offer" || current.notice.actions?.some((action) => action.busy)) return;
      remove(entry.key, entry.token);
      current.onDismiss?.();
    },
    closeTransient(occurrence: object) {
      if (snapshot.transient?.occurrence === occurrence) clearTransient();
    },
    placement(occurrence: object, visible: boolean) {
      if (snapshot.transient?.occurrence !== occurrence) return;
      placed = visible;
      if (visible) runClock(); else stopClock();
    },
    hold(occurrence: object, kind: "Pointer" | "Focus" | "Press", held: boolean) {
      if (snapshot.transient?.occurrence !== occurrence) return;
      if (held) holds.add(kind); else holds.delete(kind);
      if (held) stopClock(); else runClock();
    },
    environmentChanged() { if (blocked()) clearTransient(); },
    visibilityChanged() { if (document.hidden) stopClock(); else runClock(); },
    openActivity(trigger: HTMLElement) {
      if (!active || snapshot.activity) return;
      clearTransient();
      activityNavigated = false;
      commit({ ...snapshot, activity: { trigger } });
    },
    closeActivity() { if (snapshot.activity) commit({ ...snapshot, activity: null }); },
    navigationCommitted() {
      if (!snapshot.activity) return;
      activityNavigated = true;
      commit({ ...snapshot, activity: null });
    },
    activityNavigated: () => activityNavigated,
    resume() { active = true; runClock(); },
    dispose() { active = false; stopClock(); },
  };
}
