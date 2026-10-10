"use client";
// resolve once on mount: 204 back to the page, 401 to /login (the ended
// feedback is a cookie), 503 or no network: Retry. anything else is a defect.
import { useCallback, useEffect, useRef, useState } from "react";
import { loginPath, type ReturnTarget } from "@/lib/auth/urls";

export default function SessionRecovery({
  nextPath,
}: {
  nextPath: ReturnTarget;
}) {
  const [state, setState] = useState<"Resolving" | "Unavailable" | "Defect">(
    "Resolving",
  );
  const started = useRef(false);
  const resolve = useCallback(async () => {
    setState("Resolving");
    let status: number;
    try {
      const response = await fetch("/auth/session/resolve", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Nexus-Session": "Resolve" },
      });
      status = response.status;
    } catch (error) {
      setState(error instanceof TypeError ? "Unavailable" : "Defect");
      return;
    }
    if (status === 204) window.location.replace(nextPath);
    else if (status === 401) window.location.replace(loginPath(nextPath));
    else setState(status === 503 ? "Unavailable" : "Defect");
  }, [nextPath]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void resolve();
  }, [resolve]);

  if (state === "Defect") {
    throw new Error("Session resolution returned an internal error.");
  }
  return (
    <main>
      {state === "Unavailable" ? (
        <>
          <p role="alert">We couldn&apos;t restore your session right now.</p>
          <button type="button" onClick={() => void resolve()}>
            Retry
          </button>
        </>
      ) : (
        <p role="status">Restoring your session…</p>
      )}
    </main>
  );
}
