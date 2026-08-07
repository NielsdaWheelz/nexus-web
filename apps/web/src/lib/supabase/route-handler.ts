import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  finalizeSessionResponse,
  type NonEmptyCookieSet,
  type SessionEffect,
} from "@/lib/auth/session-response";
import {
  SUPABASE_AUTH_COOKIE_OPTIONS,
  createSupabaseDeadlineFetch,
} from "./client-config";
import { type CookieToSet } from "./types";

function isNextResponse(response: Response): response is NextResponse {
  return "cookies" in response;
}

export async function createRouteHandlerClient(
  initialCookies: readonly CookieToSet[] = [],
) {
  const cookieStore = await cookies();

  // Force Next to materialize incoming cookies before PKCE code exchange.
  cookieStore.getAll();

  const cookiesToApply: CookieToSet[] = [];
  const headersToApply: Record<string, string> = {};
  let cookieWriteCount = 0;
  const effectiveCookies = new Map(
    cookieStore.getAll().map(({ name, value }) => [name, value]),
  );
  for (const { name, value } of initialCookies) {
    effectiveCookies.set(name, value);
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: SUPABASE_AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return Array.from(effectiveCookies, ([name, value]) => ({
            name,
            value,
          }));
        },
        setAll(
          nextCookiesToSet: CookieToSet[],
          headers?: Record<string, string>
        ) {
          nextCookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
            effectiveCookies.set(name, value);
            cookiesToApply.push({ name, value, options });
            cookieWriteCount += 1;
          });
          if (headers) {
            Object.assign(headersToApply, headers);
          }
        },
      },
      global: {
        fetch: createSupabaseDeadlineFetch("Supabase auth operation timed out"),
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
    applyCookies<T extends Response>(
      response: T,
      effect: SessionEffect = { kind: "Preserve" },
    ): T {
      if (!isNextResponse(response)) {
        return response;
      }

      Object.entries(headersToApply).forEach(([key, value]) => {
        response.headers.set(key, value);
      });

      if (effect.kind === "Clear") {
        return finalizeSessionResponse(response, effect) as T;
      }

      if (cookiesToApply.length === 0) {
        return finalizeSessionResponse(response, effect) as T;
      }

      const [firstCookie, ...remainingCookies] = cookiesToApply;
      if (!firstCookie) {
        return finalizeSessionResponse(response, effect) as T;
      }
      const providerCookies: NonEmptyCookieSet = [
        firstCookie,
        ...remainingCookies,
      ];
      const combinedEffect: SessionEffect =
        effect.kind === "Rotate"
          ? {
              kind: "Rotate",
              cookiesToSet: [
                ...effect.cookiesToSet,
                ...providerCookies,
              ] as NonEmptyCookieSet,
            }
          : { kind: "Rotate", cookiesToSet: providerCookies };
      return finalizeSessionResponse(response, combinedEffect) as T;
    },
  };
}
