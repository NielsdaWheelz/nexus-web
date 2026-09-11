"use client";

import { useCallback, useState } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";

/**
 * The error channel of the query hooks' five-second re-read, classified exactly
 * as `ImportsProvider` classifies its own summary read: an abort is not a
 * failure, an expired session is re-authenticated, a strict-decode throw or a
 * same-system defect reaches the error boundary, and only a modeled API failure
 * is absorbed so the last-good data stays on screen. The defect is raised from
 * this hook's own render, so the consuming hook keeps one linear read path.
 */
export function useLiveRereadFailure(): (
  error: unknown,
  signal: AbortSignal,
) => void {
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const absorb = useCallback(
    (error: unknown, signal: AbortSignal): void => {
      if (signal.aborted || isAbortError(error)) return;
      if (handleUnauthenticated(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) {
        setDefect({ error });
        return;
      }
      // justify-ignore-error: a modeled read failure is the one branch that
      // keeps the last good data; the keyed read owns the reported channel.
    },
    [handleUnauthenticated],
  );
  if (defect !== null) throw defect.error;
  return absorb;
}
