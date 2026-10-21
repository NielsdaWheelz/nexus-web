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
  refusal: ChooserError | null;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { pending: readonly Attempt[]; refusal: ChooserError | null };
  readUnconfirmed(): boolean;
  publish(): void;
}

/** The actual parent task/visit retains these immutable creation attempts. */
export function createDestinationCreation(): DestinationCreation {
  const listeners = new Set<() => void>();
  let snapshot: { pending: readonly Attempt[]; refusal: ChooserError | null } = { pending: [], refusal: null };
  const state: DestinationCreation = {
    form: null,
    attempts: new Map<string, Attempt>(),
    refusal: null,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    readUnconfirmed: () => state.attempts.size > 0,
    publish() {
      snapshot = { pending: [...state.attempts.values()], refusal: state.refusal };
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
    if (state.form === form) return;
    state.form = form;
    state.attempts.clear();
    state.refusal = null;
    state.publish();
  }, [form, state]);

  function owns(attempt: Attempt) {
    return state.form === attempt.form && state.attempts.get(attempt.name.toLowerCase()) === attempt;
  }
  async function send(attempt: Attempt) {
    if (attempt.sending || !owns(attempt)) return;
    const wasUnconfirmed = attempt.failure !== null;
    attempt.sending = true;
    state.publish();
    const outcome = await sendCreation(attempt);
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
      state.refusal = content ? { content, retry: null } : null;
      state.publish();
      return;
    }
    state.publish();
    try { attempt.onCreated({ id: outcome.library.id, name: outcome.library.name }); }
    catch (error) { fail({ error }); }
  }
  const pending = snapshot.pending.filter(attempt => attempt.form === form);
  const failed = pending.filter(attempt => attempt.failure !== null);
  const sending = pending.filter(attempt => attempt.sending);
  const error: ChooserError | null = failed.length === 0 ? snapshot.refusal : failed.length === 1 ? { ...failed[0].failure!, busy: failed[0].sending, commandKey: `library-create:${failed[0].id}` } : {
    content: { tone: "Warning", title: "some libraries couldn’t be created", message: failed.map(attempt => attempt.name).join(", ") },
    busy: failed.some(attempt => attempt.sending),
    commandKey: `library-create:${failed.map(attempt => attempt.id).sort().join(",")}`,
    retry: failed.some(attempt => attempt.failure?.retry != null) ? () => { for (const attempt of failed) attempt.failure?.retry?.(); } : null,
  };
  return {
    pendingNames: pending.map(attempt => attempt.name),
    creating: pending.length > 0,
    error,
    status: sending.length > 0 ? `creating ${sending.map(attempt => `“${attempt.name}”`).join(", ")}…` : undefined,
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
      state.refusal = null;
      void send(attempt);
      return true;
    },
  };
}
