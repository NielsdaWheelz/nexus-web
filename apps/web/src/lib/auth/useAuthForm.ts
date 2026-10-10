"use client";
// the one submit of the four auth forms (sign-in, recovery request, password
// update, email link). it posts with redirect: "manual": success is the
// route's 303 and the browser navigates to the known success path itself
// (following inside fetch would run the target's own redirects, the
// extension's identity callback among them, as opaque fetches). failure is
// the route's {kind}; a transport failure is "Unreachable". the form throws
// for a kind it does not model, and that, like a body without a kind, is a
// defect for the error boundary.
import { useRef, useState, type FormEvent } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";

// the origin check refuses posts from any host but APP_PUBLIC_URL (the vercel
// default domain, an alias).
export const WRONG_ADDRESS: FeedbackContent = {
  tone: "Danger",
  title: "This address can’t be used with Nexus.",
  message: "Open Nexus at its usual address and try again.",
};

export function useAuthForm<Kind extends string>(
  onFailure: (kind: Kind | "Forbidden" | "Unreachable") => void,
) {
  const [pending, setPending] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const inFlight = useRef(false);
  if (defect) throw defect.error;

  async function submit(
    event: FormEvent<HTMLFormElement>,
    success: string,
    options: { replace?: boolean; validate?: () => boolean } = {},
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    if (inFlight.current) return;
    const settle = (kind: Kind | "Forbidden" | "Unreachable") => {
      inFlight.current = false;
      setPending(false);
      onFailure(kind);
    };
    try {
      if (options.validate && !options.validate()) return;
      inFlight.current = true;
      setPending(true);
      let response: Response;
      try {
        response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          credentials: "same-origin",
          redirect: "manual",
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return settle("Unreachable");
      }
      // the page is leaving: stay pending. replace: a spent token url must not
      // come back on Back.
      if (response.type === "opaqueredirect") {
        if (options.replace) window.location.replace(success);
        else window.location.assign(success);
        return;
      }
      const body = (await response.json()) as { kind?: Kind | "Forbidden" };
      if (!body.kind) throw new Error(`Auth form answered ${response.status}`);
      settle(body.kind);
    } catch (error) {
      setDefect({ error });
    }
  }

  return { pending, submit };
}
