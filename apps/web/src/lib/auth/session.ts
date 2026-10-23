// the session protocol at the response edge, provider-neutral: what a server
// component may know (verification), what a response owner may do (refresh
// inline, publish cookie effects), and the private headers every auth
// response carries. middleware and route handlers publish
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

// navigation has already been prepared by middleware: verify only, never
// refresh or write. an action can instead rerender after clearing credentials;
// it returns to the login response owner.
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
  function go(to: string): never {
    redirect(new URL(to, getEnv().appPublicOrigin).href);
  }
  const accessToken = readBearer((await cookies()).getAll());
  if (accessToken === null) {
    if (method === "POST") go(loginPath(target));
    // justify-defect: a prepared navigation must carry its successor bearer.
    throw new Error("Prepared session has no readable bearer");
  }
  let viewer: Viewer | "Rejected";
  try {
    viewer = await verify(accessToken);
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    go(unavailablePath(target));
  }
  if (viewer !== "Rejected") return viewer;
  // the provider can end a session between preparation and verification.
  // navigation rejection waits for intent instead of looping through login.
  go(method === "POST" ? loginPath(target) : unavailablePath(target));
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

// entry owners (middleware, the resolve route, extension connect) verify an
// active bearer; the bff and actions take it on the proactive margin alone, so
// a following sdk operation cannot refresh implicitly. either renews only when
// necessary; publish a rotation's writes before any later rendering or operation.
async function resolve(
  presented: readonly CookieValue[],
  verifyActive: boolean,
): Promise<LiveSession> {
  const session = readSession(presented);
  if (session.state === "anonymous") return { kind: "Anonymous" };
  const { cookieNames } = session;
  if (session.state === "ended") return { kind: "Ended", cookieNames };
  if (session.state === "active") {
    const { accessToken, canRefresh } = session;
    if (!verifyActive || (await verify(accessToken)) !== "Rejected") {
      return {
        kind: "Live",
        accessToken,
        cookies: presented,
        writes: [],
        cookieNames,
      };
    }
    if (!canRefresh) return { kind: "Ended", cookieNames };
  }
  const refreshed = await refresh(presented);
  if (refreshed.kind === "Ended") return { kind: "Ended", cookieNames };
  const written = refreshed.writes.map((write) => write.name);
  return {
    ...refreshed,
    kind: "Live",
    cookieNames: [...cookieNames, ...written],
  };
}

export const resolveEntry = (presented: readonly CookieValue[]) =>
  resolve(presented, true);

export async function liveSession(): Promise<LiveSession> {
  return resolve((await cookies()).getAll(), false);
}

// ordinary installed bff calls may verify the presented bearer but cannot
// rotate or clear native-owned credentials, even inside the renewal margin.
export async function presentedSession(): Promise<LiveSession> {
  const presented = (await cookies()).getAll();
  const accessToken = readBearer(presented);
  if (accessToken === null || (await verify(accessToken)) === "Rejected") {
    return { kind: "Anonymous" };
  }
  return { kind: "Live", accessToken, cookies: presented, writes: [], cookieNames: authCookieNames(presented) };
}

