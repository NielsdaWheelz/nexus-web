import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  getSupabaseAuthCookieNames,
  type CookieValue,
} from "@/lib/auth/session-cookie";
import { isAbortError } from "@/lib/errors";
import {
  SUPABASE_AUTH_COOKIE_OPTIONS,
  createSupabaseDeadlineFetch,
} from "@/lib/supabase/client-config";
import { type CookieToSet } from "@/lib/supabase/types";

// Supabase rotates the refresh token single-use on every successful refresh and
// reports a re-presented just-rotated token with this exact REST error code.
const REFRESH_TOKEN_ALREADY_USED_CODE = "refresh_token_already_used";

type RefreshResult =
  | { status: "refreshed"; cookiesToSet: CookieToSet[] }
  | { status: "failed"; reason: "timeout" | "auth_error" | "no_session" };

// Internal: a single attempt also surfaces the Supabase error code so the one
// retry can be gated on the precise rotation-race error and nothing else.
type RefreshAttempt =
  | { status: "refreshed"; cookiesToSet: CookieToSet[] }
  | { status: "failed"; reason: "timeout" | "no_session" }
  | { status: "failed"; reason: "auth_error"; code: string | null };

// justify-concurrency: concurrent callers in this process share one refresh,
// keyed on the presented auth-cookie value, because Supabase rotates the
// refresh token single-use and a second concurrent refresh of the same token
// would race that rotation. In-process dedup covers only one serverless
// instance; cross-instance safety rests deliberately on Supabase's 10s
// refresh_token_reuse_interval — re-presenting a just-rotated token returns the
// same new session — so no distributed lock is introduced. The bound is one
// shared refresh per distinct cookie value, which is correct: a distinct cookie
// value is a distinct refresh token and so a genuinely distinct operation.
const inFlightRefreshes = new Map<string, Promise<RefreshResult>>();

// The reconstructed auth-cookie value is the single-use refresh-token blob the
// caller presents; concurrent callers presenting the same value share one
// refresh.
function readAuthCookieValue(cookieList: readonly CookieValue[]): string {
  const cookieNames = getSupabaseAuthCookieNames(cookieList);
  return cookieNames
    .map(
      (name) => cookieList.find((cookie) => cookie.name === name)?.value ?? ""
    )
    .join("");
}

async function runBoundedRefresh(): Promise<RefreshAttempt> {
  const cookieStore = await cookies();

  // Force Next to materialize incoming cookies before the refresh reads them.
  cookieStore.getAll();

  const cookiesToSet: CookieToSet[] = [];
  let cookieWriteCount = 0;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: SUPABASE_AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(nextCookiesToSet: CookieToSet[]) {
          nextCookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
            cookiesToSet.push({ name, value, options });
            cookieWriteCount += 1;
          });
        },
      },
      global: {
        fetch: createSupabaseDeadlineFetch("Supabase refresh timed out"),
      },
    }
  );

  // refreshSession() with no argument reads the refresh token from the cookie
  // store and writes the rotated session back through setAll above.
  let result: Awaited<ReturnType<typeof supabase.auth.refreshSession>>;
  try {
    result = await supabase.auth.refreshSession();
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
    return { status: "failed", reason: "timeout" };
  }

  const { data, error } = result;
  if (error) {
    return { status: "failed", reason: "auth_error", code: error.code ?? null };
  }

  if (!data.session) {
    return { status: "failed", reason: "no_session" };
  }

  // Supabase SSR applies rotated session cookies from an auth-state callback
  // scheduled a macrotask after refreshSession resolves; drain it.
  let previousWriteCount = cookieWriteCount;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (cookieWriteCount === previousWriteCount) {
      break;
    }
    previousWriteCount = cookieWriteCount;
  }

  return { status: "refreshed", cookiesToSet };
}

async function refreshOnceWithRetry(): Promise<RefreshResult> {
  let attempt = await runBoundedRefresh();

  // Distinguish a genuine rotation race from a dead refresh token: only an
  // "already used" error is worth a single retry, and the retry re-reads the
  // cookies so it presents whatever token a concurrent rotation just wrote. Any
  // other failure is terminal — refresh is attempted at most twice, never more.
  if (
    attempt.status === "failed" &&
    attempt.reason === "auth_error" &&
    attempt.code === REFRESH_TOKEN_ALREADY_USED_CODE
  ) {
    attempt = await runBoundedRefresh();
  }

  if (attempt.status === "refreshed") {
    return { status: "refreshed", cookiesToSet: attempt.cookiesToSet };
  }

  if (attempt.reason === "auth_error") {
    console.error("auth_refresh_failed", {
      reason: "auth_error",
      code: attempt.code,
    });
    return { status: "failed", reason: "auth_error" };
  }

  console.error("auth_refresh_failed", { reason: attempt.reason });
  return { status: "failed", reason: attempt.reason };
}

/**
 * Performs exactly one bounded Supabase session refresh.
 *
 * Single-flight within this process: concurrent callers presenting the same
 * auth cookie share one refresh. Retries exactly once when Supabase reports the
 * presented refresh token was already used — a rotation race — re-reading the
 * cookies inside the retry rather than reusing stale captured state. Emits a
 * structured log line on failure.
 *
 * On success it returns the rotated cookies for the caller to apply to its own
 * response; on failure it returns a typed reason.
 */
export async function refreshSession(): Promise<RefreshResult> {
  const cookieKey = readAuthCookieValue((await cookies()).getAll());

  const inFlight = inFlightRefreshes.get(cookieKey);
  if (inFlight) {
    return inFlight;
  }

  const refresh = refreshOnceWithRetry().finally(() => {
    inFlightRefreshes.delete(cookieKey);
  });

  inFlightRefreshes.set(cookieKey, refresh);
  return refresh;
}
