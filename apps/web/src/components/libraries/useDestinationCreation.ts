"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import type { ChooserError } from "@/components/libraries/LibraryChooser";
import { useThrowLater } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { LibraryDestination } from "@/lib/libraries/api";
import { CREATION_UNCONFIRMED, sendCreation } from "@/lib/libraries/create";
import { libraryNameError } from "@/lib/libraries/views";
import { libraryErrorFeedback } from "@/lib/libraries/errors";

type Attempt = {
  readonly form: string;
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly onCreated: (destination: LibraryDestination) => void;
  sending: boolean;
  failure: ChooserError | null;
};

interface DestinationCreation {
  form: string | null;
  attempts: Map<string, Attempt>;
  refusals: Map<string, { name: string; error: ChooserError }>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { pending: readonly Attempt[]; refusals: ReadonlyMap<string, { name: string; error: ChooserError }> };
  readUnconfirmed(): boolean;
  publish(): void;
}

/** The actual parent task/visit retains these immutable creation attempts. */
export function createDestinationCreation(): DestinationCreation {
  const listeners = new Set<() => void>();
  let snapshot: ReturnType<DestinationCreation["getSnapshot"]> = { pending: [], refusals: new Map() };
  const state: DestinationCreation = {
    form: null,
    attempts: new Map<string, Attempt>(),
    refusals: new Map(),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    readUnconfirmed: () => state.attempts.size > 0,
    publish() {
      snapshot = { pending: [...state.attempts.values()], refusals: new Map(state.refusals) };
      for (const listener of listeners) listener();
    },
  };
  return state;
}

/** The form owns creation; picker visibility never retires its requests. */
export function useDestinationCreation(form: string, state: ReturnType<typeof createDestinationCreation>) {
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  useLayoutEffect(() => {
    state.form = form;
    state.attempts.clear();
    state.refusals.clear();
    state.publish();
    return () => {
      if (state.form !== form) return;
      state.form = null;
      state.attempts.clear();
      state.refusals.clear();
      state.publish();
    };
  }, [form, state]);

  function owns(attempt: Attempt) {
    return state.form === attempt.form && state.attempts.get(attempt.name.toLowerCase()) === attempt;
  }
  async function send(attempt: Attempt) {
    if (attempt.sending || !owns(attempt)) return;
    const wasUnconfirmed = attempt.failure !== null;
    attempt.sending = true;
    state.publish();
    const outcome = await sendCreation({ ...attempt, initial_items: [], expected_removal_revision: null });
    if (!owns(attempt)) return;
    attempt.sending = false;
    if (outcome.kind === "Unknown" || outcome.kind === "Refused" && wasUnconfirmed) {
      const content = libraryErrorFeedback(outcome.error, `couldn’t create “${attempt.name}”`, fail, signIn);
      attempt.failure = { content: wasUnconfirmed ? CREATION_UNCONFIRMED : content ?? CREATION_UNCONFIRMED,
        retry: () => void send(attempt) };
      state.publish();
      return;
    }
    state.attempts.delete(attempt.name.toLowerCase());
    if (outcome.kind === "Refused") {
      const content = libraryErrorFeedback(outcome.error, `couldn’t create “${attempt.name}”`, fail, signIn);
      if (content !== null) state.refusals.set(attempt.scope, { name: attempt.name, error: { content, retry: null } });
      state.publish();
      return;
    }
    state.publish();
    try { attempt.onCreated({ id: outcome.library.id, name: outcome.library.name, order_revision: outcome.library.order_revision }); }
    catch (error) { fail({ error }); }
  }
  function project(scope: string | null) {
    const pending = snapshot.pending.filter(attempt => attempt.form === form && (scope === null || attempt.scope === scope));
    const failed = pending.filter(attempt => attempt.failure !== null);
    const sending = pending.filter(attempt => attempt.sending);
    const errors = [
      ...failed.map(attempt => ({ name: attempt.name, error: { ...attempt.failure!, busy: attempt.sending, commandKey: `library-create:${attempt.id}` } })),
      ...[...snapshot.refusals].filter(([key]) => scope === null || key === scope).map(([, refusal]) => refusal),
    ];
    const error: ChooserError | null = errors.length === 0 ? null : errors.length === 1 ? errors[0].error : {
      content: { tone: "Warning", title: "some library creations need attention", message: errors.map(item => item.name).join(", ") },
      busy: failed.some(attempt => attempt.sending),
      commandKey: `library-create:${failed.map(attempt => attempt.id).sort().join(",")}`,
      retry: failed.some(attempt => attempt.failure?.retry != null) ? () => { for (const attempt of failed) attempt.failure?.retry?.(); } : null,
    };
    return {
      pendingNames: snapshot.pending.filter(attempt => attempt.form === form).map(attempt => attempt.name),
      creating: pending.length > 0,
      error,
      status: sending.length > 0 ? `creating ${sending.map(attempt => `“${attempt.name}”`).join(", ")}…` : undefined,
    };
  }
  return {
    ...project(null),
    forScope: (scope: string) => project(scope),
    admit({ name, scope, onCreated }: { name: string; scope: string; onCreated: (destination: LibraryDestination) => void }): boolean {
      name = name.trim();
      if (state.form !== form || libraryNameError(name) !== null) return false;
      const key = name.toLowerCase();
      const existing = state.attempts.get(key);
      if (existing) {
        if (existing.scope !== scope || existing.sending || existing.failure?.retry === null) return false;
        void send(existing);
        return true;
      }
      const attempt: Attempt = { form, id: crypto.randomUUID(), name, scope, onCreated, sending: false, failure: null };
      state.attempts.set(key, attempt);
      state.refusals.delete(scope);
      void send(attempt);
      return true;
    },
  };
}
