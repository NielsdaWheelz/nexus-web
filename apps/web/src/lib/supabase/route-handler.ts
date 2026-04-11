import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { type CookieToSet } from "./types";

function isNextResponse(response: Response): response is NextResponse {
  return "cookies" in response;
}

export async function createRouteHandlerClient() {
  const cookieStore = await cookies();

  // Force Next to materialize incoming cookies before PKCE code exchange.
  cookieStore.getAll();

  const cookiesToApply: CookieToSet[] = [];
  let cookieWriteCount = 0;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(nextCookiesToSet: CookieToSet[]) {
          nextCookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
            cookiesToApply.push({ name, value, options });
            cookieWriteCount += 1;
          });
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

      return response;
    },
  };
}
