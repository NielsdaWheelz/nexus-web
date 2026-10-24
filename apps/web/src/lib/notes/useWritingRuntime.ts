"use client";

// The authenticated document owns one live account writer, its narrow autosave
// loss guard, security teardown and the automatic wire-update hold. Activation
// is synchronous memory ownership; storage never gates editing.
import { useLayoutEffect, useRef, useState } from "react";
import { holdWireReload } from "@/lib/api/client";
import { beforeSecurityTeardown } from "@/lib/auth/UnauthenticatedApiBoundary";
import { hasUnsavedTexts, subscribeTexts } from "@/lib/notes/texts";
import { startWritingRuntime, stopWritingRuntime, writingAccount } from "@/lib/notes/writes";
import { reloadStrandsWriting, useWorkGuard } from "@/lib/unsavedWork";

export function useWritingRuntime(accountId: string | null): { readonly reloadHeld: boolean } {
  const owner = useRef<{ accountId: string | null } | null>(null);
  if (owner.current === null || owner.current.accountId !== accountId) {
    if (accountId !== null) startWritingRuntime(accountId);
    owner.current = { accountId };
  }
  const mount = useRef<object | null>(null);
  const guard = useWorkGuard();
  const [reloadHeld, setReloadHeld] = useState(false);
  useLayoutEffect(() => {
    if (accountId === null) return;
    const token = {};
    mount.current = token;
    const generation = startWritingRuntime(accountId);
    const releaseReload = holdWireReload(() => {
      const held = reloadStrandsWriting(guard);
      if (held) setReloadHeld(true);
      return held;
    });
    const releaseTeardown = beforeSecurityTeardown(() => stopWritingRuntime(generation));
    const unsaved = () => writingAccount() === accountId && hasUnsavedTexts();
    const releaseWriting = guard.register({
      id: `writing:${accountId}`, scope: { kind: "account" },
      subscribe: subscribeTexts,
      read: () => ({ changed: unsaved(), unconfirmed: false, stopsBrowserWork: false }),
    });
    return () => {
      releaseReload();
      releaseTeardown();
      releaseWriting();
      // Strict effect replay reacquires this owner synchronously. Real account
      // replacement is already fenced by start; security/signout stop directly.
      queueMicrotask(() => { if (mount.current === token) stopWritingRuntime(generation); });
    };
  }, [accountId, guard]);
  return { reloadHeld };
}
