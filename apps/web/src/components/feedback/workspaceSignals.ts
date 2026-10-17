import type {
  FeedbackContent,
  FeedbackOffer,
  OfferNotice,
  WorkspaceCondition,
  WorkspaceNotice,
} from "./Feedback";
import { hasActiveModal } from "@/lib/ui/overlay";

export interface WorkspaceSignal {
  readonly id: number;
  readonly key: string;
  readonly token: object;
  readonly kind: "Condition" | "Offer";
  readonly notice: WorkspaceNotice;
  readonly rank: number;
}
interface Snapshot {
  readonly entries: readonly WorkspaceSignal[];
  readonly receipt: { readonly id: number; readonly content: FeedbackContent } | null;
}
export const EMPTY_SIGNALS: Snapshot = { entries: [], receipt: null };
const PRIORITY = { Write: 0, Action: 1, Status: 2 };

/** Presentation only. Owners keep their commands, validity and settlement. */
export function createWorkspaceSignals() {
  let snapshot = EMPTY_SIGNALS;
  let nextId = 1;
  let active = true;
  const listeners = new Set<() => void>();
  const holds = new Set<"Pointer" | "Focus" | "Disclosure">();
  let clock: { remaining: number; started: number | null; timer?: ReturnType<typeof setTimeout> } | null = null;
  const commit = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const stopClock = () => {
    if (clock?.started === null || !clock) return;
    clearTimeout(clock.timer);
    clock.remaining -= Date.now() - clock.started;
    clock.started = null;
  };
  const clearReceipt = () => {
    stopClock();
    clock = null;
    if (snapshot.receipt) commit({ ...snapshot, receipt: null });
  };
  const runClock = () => {
    if (!active || !clock || clock.started !== null || holds.has("Pointer") || document.hidden) return;
    clock.started = Date.now();
    clock.timer = setTimeout(clearReceipt, Math.max(0, clock.remaining));
  };
  const ordered = (entries: readonly WorkspaceSignal[]) => holds.size > 0
    ? entries
    : entries.toSorted((a, b) => a.rank - b.rank || a.id - b.id);
  const replace = (signal: WorkspaceSignal) => {
    stopClock();
    clock = null;
    const entries = snapshot.entries.some((entry) => entry.key === signal.key)
      ? snapshot.entries.map((entry) => entry.key === signal.key ? signal : entry)
      : [...snapshot.entries, signal];
    commit({ entries: ordered(entries), receipt: null });
  };
  const remove = (key: string, token: object) => {
    const entries = snapshot.entries.filter((entry) => entry.key !== key || entry.token !== token);
    if (entries.length !== snapshot.entries.length) commit({ ...snapshot, entries: ordered(entries) });
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    receipt(content: Pick<FeedbackContent, "tone" | "title">) {
      if (!active || snapshot.entries.length > 0 || hasActiveModal()) return;
      stopClock();
      clock = { remaining: 5000, started: null };
      commit({ entries: [], receipt: { id: nextId++, content } });
      runClock();
    },
    offer(input: OfferNotice & { key: string }): FeedbackOffer {
      const { key, ...notice } = input;
      const token = {};
      if (active) {
        const old = snapshot.entries.find((entry) => entry.key === key);
        replace({ id: old?.id ?? nextId++, key, token, kind: "Offer", notice, rank: 3 });
      }
      return {
        update(next) {
          const old = snapshot.entries.find((entry) => entry.key === key && entry.token === token);
          if (active && old) replace({ ...old, notice: next });
        },
        withdraw() {
          if (active) remove(key, token);
        },
      };
    },
    condition(key: string, token: object, notice: WorkspaceCondition | null) {
      if (notice === null) return remove(key, token);
      const old = snapshot.entries.find((entry) => entry.key === key);
      // Hook registrations can replay before the provider's StrictMode setup.
      // Public callbacks still refuse publication after disposal.
      replace({ id: old?.id ?? nextId++, key, token, kind: "Condition", notice, rank: PRIORITY[notice.priority] });
    },
    withdrawCondition: remove,
    dismiss(entry: WorkspaceSignal) {
      const current = snapshot.entries.find((item) => item.key === entry.key && item.token === entry.token);
      if (current?.kind !== "Offer" || current.notice.actions?.some((action) => action.busy)) return;
      remove(entry.key, entry.token);
    },
    hold(kind: "Pointer" | "Focus" | "Disclosure", held: boolean) {
      if (held) holds.add(kind);
      else holds.delete(kind);
      if (kind === "Pointer") {
        if (held) stopClock();
        else runClock();
      }
      if (holds.size === 0) {
        const entries = ordered(snapshot.entries);
        if (entries.some((entry, index) => snapshot.entries[index] !== entry)) commit({ ...snapshot, entries });
      }
    },
    modalOpened() {
      clearReceipt();
      holds.clear();
      const entries = ordered(snapshot.entries);
      if (entries.some((entry, index) => snapshot.entries[index] !== entry)) commit({ ...snapshot, entries });
    },
    visibilityChanged() {
      if (document.hidden) stopClock();
      else runClock();
    },
    resume() { active = true; runClock(); },
    dispose() { active = false; stopClock(); },
  };
}
