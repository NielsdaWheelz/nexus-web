import {
  AUTH_OPERATION_DEADLINE_MS,
  makeAuthOperationTimeoutError,
} from "@/lib/auth/internal-fetch";

// The auth cookie is server-only: no browser Supabase client reads it, so
// HttpOnly is safe. Secure is not in @supabase/ssr's defaults; set it
// explicitly. SameSite=Lax (the default, restated) is required so the cookie
// rides the top-level OAuth callback redirect.
export const SUPABASE_AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;

// Build the Supabase SDK `global.fetch` for one Supabase auth operation. The
// returned fetch shares one total deadline across every request the SDK issues
// during the operation; a per-fetch abort would reset on each call and let a
// chain of calls run unbounded.
export function createSupabaseDeadlineFetch(timeoutMessage: string): typeof fetch {
  const operationDeadlineAt = Date.now() + AUTH_OPERATION_DEADLINE_MS;
  return (input, init) => {
    const remainingMs = operationDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      return Promise.reject(makeAuthOperationTimeoutError(timeoutMessage));
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(makeAuthOperationTimeoutError(timeoutMessage));
    }, remainingMs);
    return fetch(input, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timeoutId),
    );
  };
}
