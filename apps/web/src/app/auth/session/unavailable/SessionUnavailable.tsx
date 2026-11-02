"use client";

import { useEffect, useRef, useState } from "react";
import EntryFailure from "@/components/EntryFailure";
import { Announcement } from "@/components/feedback/Feedback";
import type { Line } from "@/components/feedback/stage";
import { TRANSPORT_LINES } from "@/lib/api/failure";
import Button from "@/components/ui/Button";
import { loginPath, type ReturnTarget } from "@/lib/auth/urls";
import { useReturnTarget } from "@/lib/auth/useReturnTarget";
import styles from "./SessionUnavailable.module.css";

type Failure = "ProviderUnavailable" | "Unconfirmed";
const NOT_OPENED = "nexus couldn’t open.";
/** A 503 is a busy provider; a thrown fetch or the deadline is offline or no answer. A new line per
 * failed retry, so each speaks. */
const failureLine = (failure: Failure): Line => failure === "ProviderUnavailable" ? TRANSPORT_LINES.Busy.command(NOT_OPENED)
  : TRANSPORT_LINES[navigator.onLine === false ? "Offline" : "Unavailable"].command(NOT_OPENED);

export default function SessionUnavailable({ nextPath }: { nextPath: ReturnTarget }) {
  const target = useReturnTarget(nextPath);
  const [failure, setFailure] = useState<Line | null>(null);
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
      setFailure(failureLine(reason));
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
      title={NOT_OPENED}
      description={failure?.reason ?? ""}
    >
      <div className={styles.action}>
        <Button
          emphasis="strong"
          disabled={target.kind === "Pending"}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          onClick={() => void retry()}
        >
          retry
        </Button>
        {failure === null ? null : <Announcement text={failure.reason ? `${failure.fact} ${failure.reason}` : failure.fact} level="Polite" occurrence={failure} />}
      </div>
    </EntryFailure>
  );
}
