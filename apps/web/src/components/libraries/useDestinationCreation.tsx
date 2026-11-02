"use client";

import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import type { ChooserError } from "@/components/libraries/LibraryChooser";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useResendVerbs } from "@/lib/collections/admissionReason";
import type { LibraryDestination } from "@/lib/libraries/api";
import { sendCreation } from "@/lib/libraries/create";
import { libraryNameError } from "@/lib/libraries/views";
import { refuseLibrary } from "@/lib/libraries/errors";

type Attempt = {
  readonly form: string;
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly onCreated: (destination: LibraryDestination) => void;
  sending: boolean;
  /** Attempts that left its outcome unconfirmed; past zero only a resend of this id is safe, and it holds. */
  unconfirmed: number;
};

interface DestinationCreation {
  form: string | null;
  attempts: Map<string, Attempt>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { pending: readonly Attempt[] };
  readUnconfirmed(): boolean;
  publish(): void;
}

/** The actual parent task/visit retains these immutable creation attempts. */
export function createDestinationCreation(): DestinationCreation {
  const listeners = new Set<() => void>();
  let snapshot: ReturnType<DestinationCreation["getSnapshot"]> = { pending: [] };
  const state: DestinationCreation = {
    form: null,
    attempts: new Map<string, Attempt>(),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    readUnconfirmed: () => state.attempts.size > 0,
    publish() {
      snapshot = { pending: [...state.attempts.values()] };
      for (const listener of listeners) listener();
    },
  };
  return state;
}

const unsure = (attempt: Attempt) => `not sure creating “${attempt.name}” saved.`;
const MAY_HAVE = "it may have gone through.";

/** The form owns creation; picker visibility never retires its requests. A refusal speaks once
 * where the form is; an unknown outcome holds, with its resend of the same id, while the form
 * renders `holds`. `error` restates the first unknown outcome for forms outside this lane that
 * still render it, and leaves with them. */
export function useDestinationCreation(form: string, state: ReturnType<typeof createDestinationCreation>) {
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const outcome = useOutcome();
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  const resendVerbs = useResendVerbs();
  useLayoutEffect(() => {
    state.form = form;
    state.attempts.clear();
    state.publish();
    return () => {
      if (state.form !== form) return;
      state.form = null;
      state.attempts.clear();
      state.publish();
    };
  }, [form, state]);

  function owns(attempt: Attempt) {
    return state.form === attempt.form && state.attempts.get(attempt.name.toLowerCase()) === attempt;
  }
  async function send(attempt: Attempt) {
    if (attempt.sending || !owns(attempt)) return;
    attempt.sending = true;
    state.publish();
    const result = await sendCreation({ ...attempt, initial_items: [], expected_removal_revision: null });
    if (!owns(attempt)) return;
    attempt.sending = false;
    // A refusal after an unknown outcome cannot say whether the first send landed. A sign-out or
    // a defect still goes to its owner.
    if (result.kind === "Unknown" || result.kind === "Refused" && attempt.unconfirmed > 0) {
      attempt.unconfirmed += 1;
      state.publish();
      modeledApiError(result.error, fail, signIn);
      return;
    }
    state.attempts.delete(attempt.name.toLowerCase());
    state.publish();
    if (result.kind === "Refused") {
      signIn(result.error);
      refuseLibrary(outcome, result.error, `couldn’t create “${attempt.name}”.`);
      return;
    }
    try { attempt.onCreated({ id: result.library.id, name: result.library.name, order_revision: result.library.order_revision }); }
    catch (error) { fail({ error }); }
  }
  function project(scope: string | null) {
    const pending = snapshot.pending.filter(attempt => attempt.form === form && (scope === null || attempt.scope === scope));
    const unknown = pending.find(attempt => attempt.unconfirmed > 0);
    const error: ChooserError | null = unknown === undefined ? null : {
      occurrence: unknown, content: { tone: "Warning", title: unsure(unknown), message: MAY_HAVE },
      retry: () => void send(unknown), busy: unknown.sending, commandKey: `library-creation:${unknown.id}`,
    };
    return {
      pendingNames: snapshot.pending.filter(attempt => attempt.form === form).map(attempt => attempt.name),
      creating: pending.length > 0,
      error,
    };
  }
  const holds: ReactNode = snapshot.pending.filter(attempt => attempt.form === form && attempt.unconfirmed > 0).map(attempt => {
    const id = `library-creation:${attempt.id}`;
    return <Hold key={id} id={id} attempt={attempt.unconfirmed - 1} line={{ fact: unsure(attempt), reason: MAY_HAVE }}
      verbs={resendVerbs({ label: "retry", commandKey: id, run: () => void send(attempt), busy: attempt.sending })} />;
  });
  return {
    ...project(null),
    holds,
    forScope: (scope: string) => project(scope),
    admit({ name, scope, onCreated }: { name: string; scope: string; onCreated: (destination: LibraryDestination) => void }): boolean {
      name = name.trim();
      if (state.form !== form || libraryNameError(name) !== null) return false;
      const key = name.toLowerCase();
      const existing = state.attempts.get(key);
      if (existing) {
        if (existing.scope !== scope || existing.sending) return false;
        void send(existing);
        return true;
      }
      const attempt: Attempt = { form, id: crypto.randomUUID(), name, scope, onCreated, sending: false, unconfirmed: 0 };
      state.attempts.set(key, attempt);
      void send(attempt);
      return true;
    },
  };
}
