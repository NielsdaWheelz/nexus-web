"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { LibraryChooserAdmission, LibraryChooserError } from "@/components/libraries/LibraryChooser";
import { apiTransportFeedback, isApiError, isUnauthenticatedApiError } from "@/lib/api/client";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { createLibrary } from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import { libraryCreateRefusalMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import { isReservedLibraryName } from "@/lib/libraries/presentation";

type Attempt = {
  libraryId: string;
  name: string;
  form: string;
  scope: string;
  sending: boolean;
  uncertain: boolean;
  onCreated: (library: LibraryDestinationSelection) => void;
};
const CREATE_TIMEOUT_MS = 30_000;

/** Draft creation keeps its exact request and frozen target above the picker.
 * The form owns its lifetime; a departed form can never apply a late result.
 */
export function useDraftLibraryCreation(form: string) {
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();
  const attempts = useRef(new Map<string, Attempt>());
  const activeForm = useRef<string | null>(form);
  const authenticationLost = useRef(false);
  const [, render] = useState(0);
  const [refusal, setRefusal] = useState<LibraryChooserError | null>(null);
  const [authenticationFailure, setAuthenticationFailure] = useState<LibraryChooserError | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  useLayoutEffect(() => {
    const formAttempts = attempts.current;
    activeForm.current = form;
    authenticationLost.current = false;
    setRefusal(null);
    setAuthenticationFailure(null);
    setDefect(null);
    return () => {
      activeForm.current = null;
      formAttempts.clear();
    };
  }, [form]);

  function owns(attempt: Attempt) {
    return activeForm.current === attempt.form
      && attempts.current.get(attempt.name.toLowerCase()) === attempt;
  }

  async function send(attempt: Attempt) {
    if (attempt.sending || !owns(attempt) || authenticationLost.current) return;
    attempt.sending = true;
    render((value) => value + 1);
    let library: LibraryDestinationSelection;
    try {
      library = await createLibrary({
        libraryId: attempt.libraryId,
        name: attempt.name,
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      });
    } catch (failure) {
      if (!owns(attempt)) return;
      if (isUnauthenticatedApiError(failure)) {
        authenticationLost.current = true;
        attempt.uncertain = true;
        if (!handleUnauthenticatedApiError(failure)) {
          setAuthenticationFailure({
            content: {
              tone: "Warning", title: "sign in to create a library",
              message: "open nexus, sign in, then share again.",
              requestId: failure.requestId,
            },
            onRetry: null,
          });
        }
        return;
      }
      const code = isApiError(failure) ? failure.code : null;
      if (!attempt.uncertain && (code === "E_NAME_INVALID" || code === "E_INVALID_REQUEST" || code === "E_FORBIDDEN")) {
        attempts.current.delete(attempt.name.toLowerCase());
        setRefusal({ content: libraryCreateRefusalMessage(code, `couldn’t create “${attempt.name}”`), onRetry: null });
      } else {
        attempt.uncertain = true;
        const expected = code === "E_NAME_INVALID" || code === "E_INVALID_REQUEST" || code === "E_FORBIDDEN"
          || isAbortError(failure) || (isApiError(failure) && apiTransportFeedback(failure, "") !== null);
        if (!expected) setDefect({ error: failure });
      }
      return;
    } finally {
      attempt.sending = false;
      if (activeForm.current === attempt.form) render((value) => value + 1);
    }
    if (!owns(attempt)) return;
    attempts.current.delete(attempt.name.toLowerCase());
    try {
      attempt.onCreated({ id: library.id, name: library.name });
    } catch (error) {
      setDefect({ error });
    }
    render((value) => value + 1);
  }

  if (defect) throw defect.error;
  const pending = [...attempts.current.values()].filter((attempt) => attempt.form === form);
  const failed = pending.filter((attempt) => attempt.uncertain && !attempt.sending);
  const sending = pending.filter((attempt) => attempt.sending);
  const error: LibraryChooserError | null = authenticationFailure ?? (failed.length > 0 ? {
    content: {
      tone: "Warning",
      title: `creation not confirmed: ${failed.map(({ name }) => `“${name}”`).join(", ")}`,
      message: "retry the same creation to confirm its result.",
    },
    onRetry: () => { for (const attempt of failed) void send(attempt); },
  } : refusal);

  return {
    pendingNames: pending.map((attempt) => attempt.name),
    creating: pending.length > 0,
    error,
    status: sending.length > 0 ? `creating ${sending.map(({ name }) => `“${name}”`).join(", ")}…` : undefined,
    admit({ name, scope, onCreated }: {
      name: string;
      scope: string;
      onCreated: (library: LibraryDestinationSelection) => void;
    }): LibraryChooserAdmission {
      name = name.trim();
      if (name.length === 0 || [...name].length > 100 || isReservedLibraryName(name) || activeForm.current !== form || authenticationLost.current) return "Rejected";
      const key = name.toLowerCase();
      const existing = attempts.current.get(key);
      if (existing) {
        if (existing.scope !== scope || existing.sending) return "Rejected";
        void send(existing);
        return "Accepted";
      }
      const attempt: Attempt = { libraryId: crypto.randomUUID(), name, form, scope, sending: false, uncertain: false, onCreated };
      attempts.current.set(key, attempt);
      setRefusal(null);
      void send(attempt);
      return "Accepted";
    },
  };
}
