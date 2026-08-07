import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  getSupabaseAuthCookieNames,
  getSupabaseAuthCookieValue,
  readSupabaseSessionCookie,
  type CookieValue,
} from "@/lib/auth/session-cookie";
import {
  AuthDependencyError,
  isAuthDependencyFailure,
  type NonEmptyCookieSet,
} from "@/lib/auth/session-response";
import { isAbortError } from "@/lib/errors";
import {
  SUPABASE_AUTH_COOKIE_OPTIONS,
  createSupabaseDeadlineFetch,
} from "@/lib/supabase/client-config";
import { type CookieToSet } from "@/lib/supabase/types";

const TERMINAL_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
]);

export type SessionRefreshOutcome =
  | { kind: "Refreshed"; cookiesToSet: NonEmptyCookieSet }
  | { kind: "SessionEnded"; cookieNames: readonly string[] };

type SessionCookieDigest = string & {
  readonly __sessionCookieDigest: unique symbol;
};

// justify-concurrency: one process shares a provider refresh for one presented
// credential. Supabase's configured reuse interval owns cross-instance races.
// The key is an irreversible digest so bearer credentials never persist in
// process-global keys.
const inFlightRefreshes = new Map<
  SessionCookieDigest,
  Promise<SessionRefreshOutcome>
>();

async function digestSessionCookie(value: string): Promise<SessionCookieDigest> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("") as SessionCookieDigest;
}

function applyCookieWrites(
  cookies: readonly CookieValue[],
  writes: readonly CookieToSet[],
): CookieValue[] {
  const values = new Map(cookies.map(({ name, value }) => [name, value]));
  for (const { name, value, options } of writes) {
    if (value === "" && options?.maxAge === 0) {
      values.delete(name);
    } else {
      values.set(name, value);
    }
  }
  return Array.from(values, ([name, value]) => ({ name, value }));
}

async function runRefresh(
  presentedCookies: readonly CookieValue[],
): Promise<SessionRefreshOutcome> {
  let providerCookies = [...presentedCookies];
  const cookiesToSet: CookieToSet[] = [];
  let cookieWriteCount = 0;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: SUPABASE_AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return providerCookies;
        },
        setAll(nextCookies: CookieToSet[]) {
          cookiesToSet.push(...nextCookies);
          providerCookies = applyCookieWrites(providerCookies, nextCookies);
          cookieWriteCount += nextCookies.length;
        },
      },
      global: {
        fetch: createSupabaseDeadlineFetch("Supabase refresh timed out"),
      },
    },
  );

  let result: Awaited<ReturnType<typeof supabase.auth.refreshSession>>;
  try {
    result = await supabase.auth.refreshSession();
  } catch (error) {
    if (isAbortError(error) || isAuthDependencyFailure(error)) {
      throw new AuthDependencyError();
    }
    throw error;
  }

  const { data, error } = result;
  if (error) {
    if (isAuthDependencyFailure(error)) {
      throw new AuthDependencyError();
    }
    if (
      (error.code !== undefined && TERMINAL_CODES.has(error.code)) ||
      error.name === "AuthSessionMissingError"
    ) {
      return {
        kind: "SessionEnded",
        cookieNames: getSupabaseAuthCookieNames(presentedCookies),
      };
    }
    // justify-defect: the fixed provider operation must classify every exact
    // error code; a new or codeless state is contract drift.
    throw new Error(
      `Unexpected Supabase refresh error code: ${error.code ?? error.name}`,
    );
  }
  if (!data.session) {
    // justify-defect: provider success must establish a session.
    throw new Error("Supabase refresh succeeded without a session");
  }

  let previousWriteCount = cookieWriteCount;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (cookieWriteCount === previousWriteCount) {
      break;
    }
    previousWriteCount = cookieWriteCount;
  }

  const [firstCookie, ...remainingCookies] = cookiesToSet;
  if (
    !firstCookie ||
    readSupabaseSessionCookie(providerCookies).state !== "active"
  ) {
    // justify-defect: refresh success must publish a non-empty, live successor
    // cookie set before any caller can continue as authenticated.
    throw new Error(
      "Supabase refresh did not produce an active successor session",
    );
  }
  return {
    kind: "Refreshed",
    cookiesToSet: [firstCookie, ...remainingCookies],
  };
}

export async function refreshSession(): Promise<SessionRefreshOutcome> {
  const presentedCookies = (await cookies()).getAll();
  const cookieValue = getSupabaseAuthCookieValue(presentedCookies);
  if (!cookieValue) {
    return {
      kind: "SessionEnded",
      cookieNames: getSupabaseAuthCookieNames(presentedCookies),
    };
  }

  const digest = await digestSessionCookie(cookieValue);
  let refresh = inFlightRefreshes.get(digest);
  if (!refresh) {
    refresh = runRefresh(presentedCookies).finally(() => {
      inFlightRefreshes.delete(digest);
    });
    inFlightRefreshes.set(digest, refresh);
  }
  return refresh;
}
