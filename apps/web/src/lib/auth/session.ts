// the session protocol at the response edge, provider-neutral: what a server
// component may know (verification), what a response owner may do (refresh
// inline, publish cookie effects), and the private headers every auth
// response carries. middleware, route handlers and server actions publish
// through the same cookie effects.
import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { assertNever } from "@/lib/assertNever";
import {
  loginPath,
  parseReturnTarget,
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
  unavailablePath,
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
  readBearer,
  readSession,
  type CookieValue,
} from "@/lib/supabase/cookie";

// set by an ending Clear for one minute; /login uses it for its heading.
// any later cookie effect (a sign-in, a sign-out) removes it.
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
  jar: {
    set(cookie: CookieValue & CookieWrite["options"]): void;
    delete(cookie: { name: string } & CookieWrite["options"]): void;
  },
  effect: Effect,
): void {
  switch (effect.kind) {
    case "Preserve":
      return;
    case "Write":
      if (effect.writes.length === 0) return;
      for (const { name, value, options } of effect.writes) {
        if (options?.maxAge === 0) jar.delete({ name, ...options });
        else jar.set({ name, value, ...options });
      }
      break;
    case "Clear":
      // native deletion: its past expiry survives next's mutable-cookie merge.
      for (const name of effect.cookieNames) jar.delete({ name, path: "/" });
      break;
    default:
      return assertNever(effect);
  }
  if (effect.kind === "Clear" && effect.feedback) {
    jar.set({
      name: ENDED_FEEDBACK_COOKIE,
      value: "1",
      httpOnly: true,
      maxAge: 60,
      path: "/",
      sameSite: "lax",
    });
  } else {
    jar.delete({ name: ENDED_FEEDBACK_COOKIE, path: "/" });
  }
}

// request cookies remove names; response cookies publish expiry attributes.
// adapt that difference without giving deletions a value on the forwarded jar.
export function applyRequestEffect(
  jar: NextRequest["cookies"],
  effect: Effect,
): void {
  applyEffect(
    {
      set: ({ name, value }) => {
        jar.set(name, value);
      },
      delete: ({ name }) => {
        jar.delete(name);
      },
    },
    effect,
  );
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
  | { readonly kind: "MissingBearer" }
  | { readonly kind: "Rejected" };

export async function getVerification(
  presented: readonly CookieValue[],
): Promise<Verification> {
  const accessToken = readBearer(presented);
  if (accessToken === null) return { kind: "MissingBearer" };
  const viewer = await verify(accessToken);
  return viewer === "Rejected"
    ? { kind: "Rejected" }
    : { kind: "Verified", viewer, accessToken };
}

// navigation has already been prepared by middleware. an action can instead
// rerender after clearing credentials; it returns to the login response owner.
export async function verifySession(): Promise<Viewer> {
  const context = await headers();
  const path = context.get(REQUEST_PATH_HEADER);
  const method = context.get(REQUEST_METHOD_HEADER);
  if (
    path === null ||
    (method !== "GET" && method !== "HEAD" && method !== "POST")
  ) {
    // justify-defect: middleware owns routing metadata on every protected request.
    throw new Error("Protected request routing metadata missing or invalid");
  }
  const target = parseReturnTarget(path);
  let verification: Verification;
  try {
    verification = await getVerification((await cookies()).getAll());
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    redirect(new URL(unavailablePath(target), getEnv().appPublicOrigin).href);
  }
  switch (verification.kind) {
    case "Verified":
      return verification.viewer;
    case "MissingBearer":
      if (method === "POST") {
        redirect(new URL(loginPath(target), getEnv().appPublicOrigin).href);
      }
      // justify-defect: a prepared navigation must carry its successor bearer.
      throw new Error("Prepared session has no readable bearer");
    case "Rejected":
      // the provider can end a session between preparation and verification.
      // navigation rejection waits for intent instead of looping through login.
      redirect(
        new URL(
          method === "POST" ? loginPath(target) : unavailablePath(target),
          getEnv().appPublicOrigin,
        ).href,
      );
    default:
      return assertNever(verification);
  }
}

// a response owner's bearer and cookie effects: publish writes for Live and
// ended(cookieNames) for Ended. neither decoded cookies nor this type authorize.
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

async function refreshLive(
  presented: readonly CookieValue[],
): Promise<LiveSession> {
  const cookieNames = authCookieNames(presented);
  const refreshed = await refresh(presented);
  switch (refreshed.kind) {
    case "Ended":
      return { kind: "Ended", cookieNames };
    case "Refreshed":
      return {
        ...refreshed,
        kind: "Live",
        cookieNames: [...cookieNames, ...refreshed.writes.map((write) => write.name)],
      };
    default:
      return assertNever(refreshed);
  }
}

// entry response owners verify an active bearer and renew only when necessary.
// after rotation, publish its writes before any later rendering or operation.
export async function resolveEntry(
  presented: readonly CookieValue[],
): Promise<LiveSession> {
  const session = readSession(presented);
  switch (session.state) {
    case "anonymous":
      return { kind: "Anonymous" };
    case "ended":
      return { kind: "Ended", cookieNames: session.cookieNames };
    case "refreshable":
      return refreshLive(presented);
    case "active": {
      const verification = await getVerification(presented);
      switch (verification.kind) {
        case "Verified":
          return {
            kind: "Live",
            accessToken: verification.accessToken,
            cookies: presented,
            writes: [],
            cookieNames: session.cookieNames,
          };
        case "Rejected":
          return session.canRefresh
            ? refreshLive(presented)
            : { kind: "Ended", cookieNames: session.cookieNames };
        case "MissingBearer":
          // justify-defect: both readers just decoded the same active cookie jar.
          throw new Error("Active session has no readable bearer");
        default:
          return assertNever(verification);
      }
    }
    default:
      return assertNever(session);
  }
}

// bff/actions prepare with the proactive margin so a following sdk operation
// cannot refresh implicitly. entry verification is deliberately separate.
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
    case "refreshable":
      return refreshLive(presented);
    default:
      return assertNever(session);
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
