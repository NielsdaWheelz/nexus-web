import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  DEFAULT_AUTH_REDIRECT,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import { createClient } from "@/lib/supabase/server";

const REQUEST_PATH_HEADER = "x-nexus-request-path";

// One total deadline for the local access-token verification. getClaims()
// verifies the ES256 signature against a cached JWKS and only fetches JWKS on a
// cache miss; the whole operation owns a single budget, never a per-fetch abort.
const VERIFY_DEADLINE_MS = 2_000;

// The verified viewer for the current request. Authentication only — resource
// ownership is checked by each caller against this identity.
export interface Viewer {
  userId: string;
  email: string | null;
}

async function clearAuthCookies(cookieNames: string[]): Promise<void> {
  const cookieStore = await cookies();
  for (const name of cookieNames) {
    try {
      cookieStore.set(name, "", { maxAge: 0, path: "/" });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      // justify-ignore-error: a Server Component cannot mutate cookies. The
      // middleware and route handlers that own the response clear the same
      // invalid cookie chunks; redirecting closed is the required boundary.
    }
  }
}

// Redirect to a public auth surface, carrying the originally requested path as
// the validated `next` so the user lands back where they were after login or
// refresh.
async function redirectCarryingNext(
  target: "/login" | "/auth/refresh",
): Promise<never> {
  const requestPath =
    (await headers()).get(REQUEST_PATH_HEADER) ?? DEFAULT_AUTH_REDIRECT;
  const nextPath = normalizeAuthRedirect(requestPath, DEFAULT_AUTH_REDIRECT);
  redirect(`${target}?next=${encodeURIComponent(nextPath)}`);
}

/**
 * The single verified-session checkpoint. Reads the auth cookie through the
 * boundary parser and acts on the four-state lifecycle:
 *
 * - `active`: verify the access token locally via `getClaims()` within a total
 *   deadline and return the viewer.
 * - `refreshable`: redirect to `/auth/refresh` so the session is refreshed
 *   before the page renders.
 * - `ended` / `anonymous`: clear the auth cookie chunks, log the involuntary
 *   logout, and redirect to `/login`.
 *
 * Memoized per request: every protected page, route handler, and server action
 * calls it directly, and the verification runs at most once per request.
 */
export const verifySession = cache(async (): Promise<Viewer> => {
  const session = readSupabaseSessionCookie((await cookies()).getAll());

  switch (session.state) {
    case "active": {
      const supabase = await createClient();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const { data, error } = await Promise.race([
          supabase.auth.getClaims(session.accessToken),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Access token verification timed out")),
              VERIFY_DEADLINE_MS,
            );
          }),
        ]).finally(() => {
          if (timeout) {
            clearTimeout(timeout);
          }
        });
        if (!error && data) {
          return {
            userId: data.claims.sub,
            email: data.claims.email ?? null,
          };
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        console.error("auth_session_verify_failed", { reason: error.message });
      }
      // An `active` cookie whose token does not verify locally is a forged or
      // corrupt token, not an expiry: there is nothing to refresh. Treat it as
      // an involuntary logout.
      console.error("auth_involuntary_logout", { reason: "verify_rejected" });
      await clearAuthCookies(session.cookieNames);
      return redirectCarryingNext("/login");
    }
    case "refreshable":
      return redirectCarryingNext("/auth/refresh");
    case "ended":
      // A refresh token that is absent, rejected, or revoked: a session that
      // existed has ended without an explicit signout — an involuntary logout.
      console.error("auth_involuntary_logout", { reason: session.reason });
      await clearAuthCookies(session.cookieNames);
      return redirectCarryingNext("/login");
    case "anonymous":
      // `malformed` / `non_bearer` mean a present cookie was rejected — a lost
      // session, so logged. `missing` / `bad_config` are a request that never
      // carried a session and are an ordinary redirect, not a logout.
      if (session.reason === "malformed" || session.reason === "non_bearer") {
        console.error("auth_involuntary_logout", { reason: session.reason });
      }
      await clearAuthCookies(session.cookieNames);
      return redirectCarryingNext("/login");
  }

  session satisfies never;
});

/**
 * Returns the verified viewer for the current request. A read alias over
 * `verifySession()` for call sites that consume the identity rather than gate
 * on it; both share the one per-request memoized verification.
 */
export const getCurrentUser = cache(verifySession);
