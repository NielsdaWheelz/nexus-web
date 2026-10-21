"use client";

// One tab's writing runtime for one account, shared by the authenticated shell and
// share capture: the journal lease before editors mount, the one document-exit
// guard, the held wire reload and the pause before a login redirect. Callers
// present its states; the auth context decides redirect policy (the shell's login
// navigation, share capture's no-op).
import { useEffect, useState } from "react";
import { apiFetch, holdWireReload, isUnauthenticatedApiError } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { beforeSecurityTeardown, useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { pauseWriting, startWritingRuntime, stopWritingRuntime } from "@/lib/notes/journal";
import { nudgeWrites } from "@/lib/notes/writes";
import { guardDocumentExit, reloadStrandsWriting } from "@/lib/unsavedWork";

export interface WritingRuntime {
  /**
   * "ready": the start resolved and this tab holds the account's lease (storage
   * failure included, as the journal's storage state). "failed": no lease, so
   * nothing may edit; `retry` starts again, "retrying" until it settles.
   * "starting": the first start has not settled.
   */
  readonly state: "starting" | "ready" | "failed" | "retrying";
  /** A new build's automatic reload was held because it would strand writing. */
  readonly reloadHeld: boolean;
  readonly retry: () => void;
}

/** Starts nothing until the account is known. Mount once per tab. */
export function useWritingRuntime(accountId: string | null): WritingRuntime {
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ accountId: string; attempt: number; ready: boolean } | null>(null);
  const [reloadHeld, setReloadHeld] = useState(false);
  useEffect(() => {
    if (accountId === null) return;
    let current = true;
    const releaseReload = holdWireReload(() => {
      const held = reloadStrandsWriting();
      if (held && current) setReloadHeld(true);
      return held;
    });
    const releaseTeardown = beforeSecurityTeardown(pauseWriting);
    const releaseExit = guardDocumentExit();
    // The lease rechecks the session's account; an ended session is null.
    const sessionAccountId = async (): Promise<string | null> => {
      try {
        return (await apiFetch<ApiJson<"/me", "get">>("/api/me")).data.user_id;
      } catch (error) {
        if (!isUnauthenticatedApiError(error)) throw error;
        handleUnauthenticated(error);
        return null;
      }
    };
    startWritingRuntime(accountId, sessionAccountId).then(
      () => {
        if (!current) return;
        nudgeWrites();
        setSettled({ accountId, attempt, ready: true });
      },
      () => {
        if (current) setSettled({ accountId, attempt, ready: false });
      },
    );
    return () => {
      current = false;
      releaseReload();
      releaseTeardown();
      releaseExit();
      void stopWritingRuntime();
    };
  }, [accountId, attempt, handleUnauthenticated]);
  const outcome = accountId !== null && settled?.accountId === accountId ? settled : null;
  return {
    state: outcome === null ? "starting"
      : outcome.attempt !== attempt ? "retrying"
      : outcome.ready ? "ready" : "failed",
    reloadHeld,
    retry: () => setAttempt((value) => value + 1),
  };
}
