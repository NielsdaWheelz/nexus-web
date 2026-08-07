import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { type NextResponse } from "next/server";
import { AUTH_ENDED_FEEDBACK_COOKIE } from "@/lib/auth/messages";
import { noStore } from "@/lib/auth/no-store";
import { clearSupabaseAuthCookies } from "@/lib/auth/session-cookie";
import { type CookieToSet } from "@/lib/supabase/types";

export class AuthDependencyError extends Error {
  override readonly name = "AuthDependencyError";

  constructor() {
    super("Authentication dependency unavailable");
  }
}

export function isAuthDependencyFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = "status" in error ? error.status : undefined;
  const code = "code" in error ? error.code : undefined;
  return (
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    code === "request_timeout" ||
    code === "conflict"
  );
}

export type NonEmptyCookieSet = readonly [CookieToSet, ...CookieToSet[]];

export type SessionEffect =
  | { kind: "Preserve" }
  | { kind: "Rotate"; cookiesToSet: NonEmptyCookieSet }
  | {
      kind: "Clear";
      cookieNames: readonly string[];
      feedback: boolean;
    };

export function finalizeSessionResponse<T extends NextResponse>(
  response: T,
  effect: SessionEffect,
): T {
  switch (effect.kind) {
    case "Preserve":
      break;
    case "Rotate":
      for (const { name, value, options } of effect.cookiesToSet) {
        response.cookies.set(name, value, options);
      }
      break;
    case "Clear":
      clearSupabaseAuthCookies(response, effect.cookieNames);
      if (effect.feedback) {
        response.cookies.set(AUTH_ENDED_FEEDBACK_COOKIE, "1", {
          httpOnly: true,
          maxAge: 60,
          path: "/",
          sameSite: "lax",
        });
      }
      break;
    default:
      effect satisfies never;
  }

  noStore(response);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Vary", "Cookie");
  return response;
}
