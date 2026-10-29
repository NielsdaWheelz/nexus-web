import { createContext } from "react";
import type { FeedbackNoticeProps } from "./Feedback";
import { getInteractionOwner, type Layer } from "@/lib/ui/overlay";
import { createTransientFeedback } from "./transient";

export type FeedbackHost = {
  layer: HTMLElement | null;
  bounds: HTMLElement | null;
  interaction: Layer | null;
  modal: Layer | null;
  active: boolean;
  protectedTargets: () => readonly HTMLElement[];
  returnFocus: () => HTMLElement | null;
};
export type Failure = FeedbackNoticeProps & { occurrence: object; announcementOccurrence?: object };

/** Only mounted contributors live here. A row withdraws its own token, never an incident's other rows. */
export function createFeedbackSet() {
  const entries = new Map<object, Failure>();
  const pending = new Set<object>();
  const listeners = new Set<() => void>();
  let snapshot = { failures: [] as readonly Failure[], pending: null as object | null };
  const changed = () => {
    snapshot = { failures: [...entries.values()], pending: [...pending].at(-1) ?? null };
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => snapshot,
    publish(token: object, failure: Failure) { entries.set(token, failure); changed(); },
    withdraw(token: object) { if (entries.delete(token)) changed(); },
    pending(token: object, value: boolean) { if (value ? !pending.has(token) : pending.has(token)) { if (value) pending.add(token); else pending.delete(token); changed(); } },
    changed,
  };
}
export function createFeedbackSession() {
  const keys = new WeakMap<object, number>();
  let nextKey = 0;
  return {
    key(occurrence: object) { let key = keys.get(occurrence); if (key === undefined) { key = ++nextKey; keys.set(occurrence, key); } return key; },
    transient: createTransientFeedback(),
    account: createFeedbackSet(),
    acknowledged: new WeakMap<object, object>(),
    spoken: new WeakMap<object, object>(),
  };
}
export const Session = createContext<ReturnType<typeof createFeedbackSession> | null>(null);
export type FeedbackScopeValue = ReturnType<typeof createFeedbackSet> & {
  host: FeedbackHost;
  recovery: Layer | null;
  disclosure: HTMLElement | null;
  disclosures: Set<Layer>;
  disclosureTargets: Set<HTMLElement>;
  recoveryOpen: boolean;
  control: HTMLElement | null;
  eligible(): boolean;
  mayRestoreFocus(): boolean;
  returnFocus(): HTMLElement | null;
};
export const Scope = createContext<FeedbackScopeValue | null>(null);
export function hostEligible(scope: FeedbackScopeValue): boolean {
  const { host } = scope;
  if (!host.active || !host.bounds?.isConnected || !host.layer?.isConnected) return false;
  const owner = getInteractionOwner();
  return owner === null ? host.interaction === null : owner === host.interaction || owner === scope.recovery || scope.disclosures.has(owner);
}
