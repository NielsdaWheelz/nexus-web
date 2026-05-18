/**
 * Server-side Supabase client for Next.js route handlers and server components.
 *
 * This client uses cookies for session management and should only be used
 * on the server side (route handlers, server components, middleware).
 *
 * Security:
 * - Access tokens are never exposed to the browser
 * - Session is managed via HTTP-only cookies
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { type CookieToSet } from "./types";

const SUPABASE_AUTH_OPERATION_DEADLINE_MS = 5_000;

function makeAuthOperationTimeoutError() {
  return new DOMException("Supabase auth operation timed out", "AbortError");
}

/**
 * Create a Supabase client for server-side operations.
 *
 * Uses cookies for session management. The access token is extracted
 * from the session for forwarding to FastAPI.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const operationDeadlineAt = Date.now() + SUPABASE_AUTH_OPERATION_DEADLINE_MS;

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // The auth cookie is server-only: no browser Supabase client reads it, so
      // HttpOnly is safe. Secure is not in @supabase/ssr's defaults; set it
      // explicitly. SameSite=Lax (the default, restated) is required so the
      // cookie rides the top-level OAuth callback redirect.
      cookieOptions: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
              cookieStore.set(name, value, options)
            );
          } catch (error) {
            if (!(error instanceof Error)) {
              throw error;
            }
            // justify-ignore-error: a Server Component cannot mutate cookies.
            // Middleware and route handlers that own the response refresh and
            // rotate the same session cookies, so the write is safely dropped
            // here.
          }
        },
      },
      global: {
        // Share one total deadline across every fetch in the operation. A
        // per-fetch abort window resets on each request and lets a chain of
        // calls run unbounded; this budget is the contract's required shape.
        fetch(input, init) {
          const remainingMs = operationDeadlineAt - Date.now();
          if (remainingMs <= 0) {
            return Promise.reject(makeAuthOperationTimeoutError());
          }

          const controller = new AbortController();
          const timeout = setTimeout(() => {
            controller.abort(makeAuthOperationTimeoutError());
          }, remainingMs);

          return fetch(input, { ...init, signal: controller.signal }).finally(
            () => clearTimeout(timeout)
          );
        },
      },
    }
  );
}
