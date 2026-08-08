"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildLoginUrl, type AuthReturnTarget } from "@/lib/auth/redirects";

type RecoveryState = "Resolving" | "Unavailable" | "Defect";

export default function SessionRecovery({
  nextPath,
}: {
  nextPath: AuthReturnTarget;
}) {
  const [state, setState] = useState<RecoveryState>("Resolving");
  const started = useRef(false);
  const resolving = useRef(false);

  const resolve = useCallback(async () => {
    if (resolving.current) {
      return;
    }
    resolving.current = true;
    setState("Resolving");

    try {
      const response = await fetch("/auth/session/resolve", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Nexus-Session": "Resolve" },
      });

      switch (response.status) {
        case 204:
          window.location.replace(nextPath);
          return;
        case 401:
          window.location.replace(
            buildLoginUrl(window.location.origin, nextPath).toString(),
          );
          return;
        case 503:
          setState("Unavailable");
          return;
        case 500:
          setState("Defect");
          return;
        default:
          setState("Defect");
          return;
      }
    } catch (error) {
      if (error instanceof TypeError) {
        setState("Unavailable");
        return;
      }
      setState("Defect");
    } finally {
      resolving.current = false;
    }
  }, [nextPath]);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void resolve();
  }, [resolve]);

  if (state === "Defect") {
    throw new Error("Session resolution returned an internal error.");
  }

  if (state === "Unavailable") {
    return (
      <main>
        <p role="alert">We couldn&apos;t restore your session right now.</p>
        <button type="button" onClick={() => void resolve()}>
          Retry
        </button>
      </main>
    );
  }

  return (
    <main>
      <p role="status">Restoring your session…</p>
    </main>
  );
}
