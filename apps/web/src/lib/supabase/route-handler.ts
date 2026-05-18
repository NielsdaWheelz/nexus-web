import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { type CookieToSet } from "./types";

const SUPABASE_AUTH_OPERATION_DEADLINE_MS = 5_000;

function isNextResponse(response: Response): response is NextResponse {
  return "cookies" in response;
}

function makeAuthOperationTimeoutError() {
  return new DOMException("Supabase auth operation timed out", "AbortError");
}

export async function createRouteHandlerClient() {
  const cookieStore = await cookies();
  const operationDeadlineAt =
    Date.now() + SUPABASE_AUTH_OPERATION_DEADLINE_MS;

  // Force Next to materialize incoming cookies before PKCE code exchange.
  cookieStore.getAll();

  const cookiesToApply: CookieToSet[] = [];
  const headersToApply: Record<string, string> = {};
  let cookieWriteCount = 0;

  const supabase = createServerClient(
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
        setAll(
          nextCookiesToSet: CookieToSet[],
          headers?: Record<string, string>
        ) {
          nextCookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
            cookiesToApply.push({ name, value, options });
            cookieWriteCount += 1;
          });
          if (headers) {
            Object.assign(headersToApply, headers);
          }
        },
      },
      global: {
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

  return {
    supabase,
    async settlePendingCookieWrites() {
      let previousWriteCount = cookieWriteCount;

      // Supabase SSR applies persisted session cookies from an auth-state
      // callback scheduled on the next macrotask after exchangeCodeForSession.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (cookieWriteCount === previousWriteCount) {
          break;
        }

        previousWriteCount = cookieWriteCount;
      }
    },
    applyCookies<T extends Response>(response: T): T {
      if (!isNextResponse(response)) {
        return response;
      }

      cookiesToApply.forEach(({ name, value, options }) => {
        response.cookies.set(name, value, options);
      });
      // Forward cache-busting headers so CDNs/proxies don't cache
      // responses that carry auth cookies.
      Object.entries(headersToApply).forEach(([key, value]) => {
        response.headers.set(key, value);
      });

      return response;
    },
  };
}
