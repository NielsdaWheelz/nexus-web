"use client";

import { useEffect } from "react";

// Refresh at ~67% of the ~1h access-token TTL — comfortably inside the cutover's
// 50-75% band, so the session is renewed before it can reach `refreshable` and
// the middleware-redirect / inline-refresh paths are hit only on cold loads.
const REFRESH_INTERVAL_MS = 40 * 60 * 1000;
// Random delay added on top of each scheduled tick so multiple tabs — or web and
// the Android shell opened together — do not all refresh at the same wall-clock
// moment and race the single-use refresh token.
const REFRESH_JITTER_MS = 5 * 60 * 1000;

/**
 * Keeps the httpOnly session cookie fresh while mounted by calling
 * `POST /auth/refresh` on a jittered timer and on tab resume. The server is the
 * only refresher: this is a plain credentialed same-origin `fetch`, not a
 * Supabase client, and it reads no token.
 */
export default function SessionRefresher() {
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      // Single-flight: never overlap refreshes. The refresh token is single-use,
      // so two in-flight calls would race a rotation.
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await fetch("/auth/refresh", { method: "POST" });
      } catch (error) {
        // A failed proactive refresh is non-fatal: the next protected request
        // re-classifies the cookie and the middleware/DAL refresh path takes
        // over. Network errors here are expected (offline tab) and swallowed.
        if (!(error instanceof TypeError)) throw error;
        // justify-ignore-error: a transient fetch failure has no client-side
        // remedy; the request-time refresh path is the backstop.
      } finally {
        inFlight = false;
      }
    }

    // justify-polling: the access-token TTL is a fixed server clock with no
    // push channel, so the session must be renewed on a cadence. The interval
    // is one self-rescheduling tick (fresh jitter per cycle) at ~67% of the TTL
    // — frequent enough to renew before expiry, infrequent relative to it.
    function schedule() {
      timer = setTimeout(
        () => {
          void refresh();
          schedule();
        },
        REFRESH_INTERVAL_MS + Math.random() * REFRESH_JITTER_MS
      );
    }

    function onVisibilityChange() {
      // Covers the Android-shell resume case, where background timers were
      // frozen and the scheduled tick may be long overdue.
      if (document.visibilityState === "visible") void refresh();
    }

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
