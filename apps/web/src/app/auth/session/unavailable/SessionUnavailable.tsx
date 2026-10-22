"use client";

import { useEffect, useRef, useState } from "react";
import EntryFailure from "@/components/EntryFailure";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { loginPath, type ReturnTarget } from "@/lib/auth/urls";
import { useReturnTarget } from "@/lib/auth/useReturnTarget";
import styles from "./SessionUnavailable.module.css";

type Failure = "ProviderUnavailable" | "Unconfirmed";
const DESCRIPTION: Record<Failure, string> = {
  ProviderUnavailable: "sign-in is temporarily unavailable. try again in a moment.",
  Unconfirmed: "nexus didn’t respond. check your connection and try again.",
};

export default function SessionUnavailable({ nextPath }: { nextPath: ReturnTarget }) {
  const target = useReturnTarget(nextPath);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => {
    const request = active.current;
    active.current = null;
    request?.abort();
  }, []);

  async function retry() {
    if (target.kind === "Pending" || active.current !== null) return;
    const request = new AbortController();
    active.current = request;
    setPending(true);
    const fail = (reason: Failure) => {
      active.current = null;
      setFailure(reason);
      setPending(false);
    };
    // This bounds the browser's wait, not a refresh the provider has performed.
    const deadline = setTimeout(() => {
      if (active.current !== request) return;
      request.abort();
      fail("Unconfirmed");
    }, 12_000);
    try {
      let response: Response;
      try {
        response = await fetch("/auth/session/resolve", {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-Nexus-Session": "Resolve" },
          signal: request.signal,
        });
      } catch (error) {
        if (error instanceof TypeError) {
          if (active.current === request) fail("Unconfirmed");
          // justify-ignore-error: a retired attempt's transport failure is already settled.
          return;
        }
        if (
          request.signal.aborted &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          // justify-ignore-error: deadline/unmount already owns this cancellation.
          return;
        }
        throw error;
      }
      if (active.current !== request) return;
      if (response.status === 204) window.location.replace(target.target);
      else if (response.status === 401) window.location.replace(loginPath(target.target));
      else if (response.status === 503) fail("ProviderUnavailable");
      else {
        // justify-defect: the manual resolver has no other successful product outcome.
        throw new Error(`Session resolution returned unexpected status ${response.status}`);
      }
    } catch (error) {
      if (active.current === request) setDefect({ error });
      else console.error("Session retry failed after cancellation:", error);
    } finally {
      clearTimeout(deadline);
    }
  }

  if (defect) throw defect.error;
  return (
    <EntryFailure
      title="nexus couldn’t open"
      description={failure === null ? "try again to continue." : DESCRIPTION[failure]}
    >
      <div className={styles.action}>
        <Button
          emphasis="strong"
          disabled={target.kind === "Pending"}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          onClick={() => void retry()}
        >
          try again
        </Button>
        {pending || failure !== null ? <FeedbackStatus content={{ tone: pending ? "Neutral" : "Warning", title: pending ? "checking sign-in…" : DESCRIPTION[failure!] }} announcement="Polite" /> : null}
      </div>
    </EntryFailure>
  );
}
