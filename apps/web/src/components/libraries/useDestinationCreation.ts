"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ChooserError } from "@/components/libraries/LibraryChooser";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createLibrary, type LibraryDestination } from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import { isReservedName } from "@/lib/libraries/views";

type Attempt = {
  readonly form: string;
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly onCreated: (destination: LibraryDestination) => void;
  sending: boolean;
  failure: ChooserError | null;
};

/** The form owns current creation attempts and their frozen targets, never the picker. */
export function useDestinationCreation(form: string) {
  const attempts = useRef(new Map<string, Attempt>());
  const activeForm = useRef<string | null>(form);
  const [, render] = useState(0);
  const [refusal, setRefusal] = useState<ChooserError | null>(null);
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  useLayoutEffect(() => {
    const owned = attempts.current;
    activeForm.current = form;
    setRefusal(null);
    return () => { activeForm.current = null; owned.clear(); };
  }, [form]);

  function owns(attempt: Attempt) {
    return activeForm.current === form && attempts.current.get(attempt.name.toLowerCase()) === attempt;
  }
  async function send(attempt: Attempt) {
    if (attempt.sending || !owns(attempt)) return;
    attempt.sending = true;
    attempt.failure = null;
    render(value => value + 1);
    let library: LibraryDestination;
    try {
      library = await createLibrary({ id: attempt.id, name: attempt.name });
    } catch (error) {
      if (!owns(attempt)) return;
      const content = libraryErrorFeedback(error, `couldn’t create “${attempt.name}”`, fail, signIn);
      if (content && isApiError(error) && apiTransportFeedback(error, content.title) !== null) {
        attempt.failure = { content, retry: error.code === "E_WIRE_MISMATCH" ? null : () => { void send(attempt); } };
      } else {
        attempts.current.delete(attempt.name.toLowerCase());
        setRefusal(content ? { content, retry: null } : null);
      }
      return;
    } finally {
      attempt.sending = false;
      if (activeForm.current === form) render(value => value + 1);
    }
    if (!owns(attempt)) return;
    attempts.current.delete(attempt.name.toLowerCase());
    try { attempt.onCreated({ id: library.id, name: library.name }); }
    catch (error) { fail({ error }); }
    render(value => value + 1);
  }
  const pending = [...attempts.current.values()].filter(attempt => attempt.form === form);
  const failed = pending.filter(attempt => attempt.failure !== null);
  const sending = pending.filter(attempt => attempt.sending);
  const error: ChooserError | null = failed.length === 0 ? refusal : failed.length === 1 ? failed[0].failure : {
    content: { tone: "Warning", title: "some libraries couldn’t be created", message: failed.map(attempt => attempt.name).join(", ") },
    retry: failed.some(attempt => attempt.failure?.retry != null) ? () => { for (const attempt of failed) attempt.failure?.retry?.(); } : null,
  };
  return {
    pendingNames: pending.map(attempt => attempt.name),
    creating: pending.length > 0,
    error,
    status: sending.length > 0 ? `creating ${sending.map(attempt => `“${attempt.name}”`).join(", ")}…` : undefined,
    admit({ name, scope, onCreated }: { name: string; scope: string; onCreated: (destination: LibraryDestination) => void }): boolean {
      name = name.trim();
      if (activeForm.current !== form || name === "" || [...name].length > 100 || isReservedName(name)) return false;
      const key = name.toLowerCase();
      const existing = attempts.current.get(key);
      if (existing) {
        if (existing.scope !== scope || existing.sending || existing.failure?.retry === null) return false;
        void send(existing);
        return true;
      }
      const attempt: Attempt = { form, id: crypto.randomUUID(), name, scope, onCreated, sending: false, failure: null };
      attempts.current.set(key, attempt);
      setRefusal(null);
      void send(attempt);
      return true;
    },
  };
}
