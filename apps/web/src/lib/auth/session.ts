// the session protocol at the response edge, provider-neutral: what a server
// component may know (verification), what a response owner may do (refresh
// inline, publish cookie effects), and the private headers every auth
// response carries. only finish() (route handlers) and withActionSession()
// (server actions) publish auth cookies.
import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import {
  loginPath,
  parseReturnTarget,
  recoverPath,
  REQUEST_PATH_HEADER,
} from "@/lib/auth/urls";
import { getEnv } from "@/lib/env";
import {
  AuthUnavailable,
  refresh,
  verify,
  type CookieWrite,
  type Viewer,
} from "@/lib/supabase/auth";
import {
  authCookieNames,
  readSession,
  type CookieValue,
} from "@/lib/supabase/cookie";

// set by an ending Clear for one minute; /login renders "Your session ended."
// from it. any later cookie effect (a sign-in, a sign-out) removes it.
export const ENDED_FEEDBACK_COOKIE = "nexus.auth-ended.v1";

export type Effect =
  | { readonly kind: "Preserve" }
  | { readonly kind: "Write"; readonly writes: readonly CookieWrite[] }
  | {
      readonly kind: "Clear";
      readonly cookieNames: readonly string[];
      readonly feedback: boolean;
    };

// the session ended under this request: clear every name it may hold and
// tell /login.
export const ended = (cookieNames: readonly string[]): Effect => ({
  kind: "Clear",
  cookieNames: [...new Set(cookieNames)],
  feedback: true,
});

// an establishment that does not end with this user agent keeping the
// session: clear the presented names and whatever the attempt wrote, silently.
export const abandoned = (
  presented: readonly CookieValue[],
  writes: readonly CookieWrite[],
): Effect => ({
  kind: "Clear",
  cookieNames: [
    ...new Set([...authCookieNames(presented), ...writes.map((w) => w.name)]),
  ],
  feedback: false,
});

function applyEffect(
  jar: Pick<NextResponse["cookies"], "set" | "delete">,
  effect: Effect,
): void {
  if (effect.kind === "Preserve") return;
  if (effect.kind === "Write") {
    if (effect.writes.length === 0) return;
    for (const { name, value, options } of effect.writes) {
      if (options?.maxAge === 0) jar.delete({ name, ...options });
      else jar.set(name, value, options);
    }
  } else {
    // native deletion: its past expiry survives next's mutable-cookie merge.
    for (const name of effect.cookieNames) jar.delete({ name, path: "/" });
  }
  if (effect.kind === "Clear" && effect.feedback) {
    jar.set(ENDED_FEEDBACK_COOKIE, "1", {
      httpOnly: true,
      maxAge: 60,
      path: "/",
      sameSite: "lax",
    });
  } else {
    jar.delete({ name: ENDED_FEEDBACK_COOKIE, path: "/" });
  }
}

// every auth response is private: an intermediary must never replay a session
// outcome.
export function finish<T extends NextResponse>(
  response: T,
  effect: Effect = { kind: "Preserve" },
): T {
  applyEffect(response.cookies, effect);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

// absolute redirects and origin checks know one origin: APP_PUBLIC_URL.
export function redirectTo(
  path: string,
  status: 302 | 303 | 307 = 307,
): NextResponse {
  return NextResponse.redirect(new URL(path, getEnv().appPublicOrigin), status);
}

export function isSameOrigin(request: Request): boolean {
  return request.headers.get("origin") === getEnv().appPublicOrigin;
}

// verification: for whoever only needs to know the viewer. never refreshes,
// never writes. throws AuthUnavailable.
export type Verification =
  | {
      readonly kind: "Verified";
      readonly viewer: Viewer;
      readonly accessToken: string;
    }
  | { readonly kind: "RefreshRequired" }
  | { readonly kind: "SessionEnded"; readonly cookieNames: readonly string[] }
  | { readonly kind: "Anonymous" };

export async function getVerification(): Promise<Verification> {
  const session = readSession((await cookies()).getAll());
  switch (session.state) {
    case "anonymous":
      return { kind: "Anonymous" };
    case "refreshable":
      return { kind: "RefreshRequired" };
    case "ended":
      return { kind: "SessionEnded", cookieNames: session.cookieNames };
    case "active": {
      const viewer = await verify(session.accessToken);
      if (viewer !== "Rejected") {
        return { kind: "Verified", viewer, accessToken: session.accessToken };
      }
      return session.canRefresh
        ? { kind: "RefreshRequired" }
        : { kind: "SessionEnded", cookieNames: session.cookieNames };
    }
  }
}

// the gate of protected server components: the viewer, or a redirect carrying
// the requested path (stamped by middleware) to /login or to the resolver.
export async function verifySession(): Promise<Viewer> {
  const target = parseReturnTarget((await headers()).get(REQUEST_PATH_HEADER));
  let verification: Verification;
  try {
    verification = await getVerification();
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    redirect(recoverPath(target));
  }
  if (verification.kind === "Verified") return verification.viewer;
  redirect(
    verification.kind === "Anonymous" ? loginPath(target) : recoverPath(target),
  );
}

// liveness: for a response owner that needs a bearer now. refreshes inline
// through the one refresh owner; the caller publishes `writes` (Live) or
// ended(cookieNames) (Ended). a Live session is active with margin, so the
// sdk will not refresh it again. throws AuthUnavailable.
export type LiveSession =
  | {
      readonly kind: "Live";
      readonly accessToken: string;
      readonly cookies: readonly CookieValue[];
      readonly writes: readonly CookieWrite[];
      // presented and written auth names: what an ending response clears.
      readonly cookieNames: readonly string[];
    }
  | { readonly kind: "Ended"; readonly cookieNames: readonly string[] }
  | { readonly kind: "Anonymous" };

export async function liveSession(): Promise<LiveSession> {
  const presented = (await cookies()).getAll();
  const session = readSession(presented);
  switch (session.state) {
    case "anonymous":
      return { kind: "Anonymous" };
    case "ended":
      return { kind: "Ended", cookieNames: session.cookieNames };
    case "active":
      return {
        kind: "Live",
        accessToken: session.accessToken,
        cookies: presented,
        writes: [],
        cookieNames: session.cookieNames,
      };
    case "refreshable": {
      const refreshed = await refresh(presented);
      if (refreshed.kind === "Ended") {
        return { kind: "Ended", cookieNames: session.cookieNames };
      }
      return {
        ...refreshed,
        kind: "Live",
        cookieNames: [
          ...session.cookieNames,
          ...refreshed.writes.map((w) => w.name),
        ],
      };
    }
  }
}

// a server action that calls the provider as the viewer. the action owns its
// response, so it publishes through next's cookie store: the rotation first
// (a spent refresh token must never be lost to a later failure), then the
// operation's writes. null: no live session (an ended one is cleared, with
// feedback, and so is one the provider ends under the operation) or the
// provider is unavailable.
export async function withActionSession<
  T extends {
    readonly outcome: string;
    readonly writes: readonly CookieWrite[];
  },
>(
  operation: (cookies: readonly CookieValue[]) => Promise<T>,
): Promise<T | null> {
  const store = await cookies();
  let live: LiveSession;
  try {
    live = await liveSession();
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    return null;
  }
  if (live.kind === "Ended") applyEffect(store, ended(live.cookieNames));
  if (live.kind !== "Live") return null;
  applyEffect(store, { kind: "Write", writes: live.writes });
  const result = await operation(live.cookies);
  if (result.outcome === "SessionEnded") {
    const names = [...live.cookieNames, ...result.writes.map((w) => w.name)];
    applyEffect(store, ended(names));
    return null;
  }
  applyEffect(store, { kind: "Write", writes: result.writes });
  return result;
}
