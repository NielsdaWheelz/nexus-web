import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  finalizeSessionResponse,
  type NonEmptyCookieSet,
  type SessionEffect,
} from "@/lib/auth/session-response";
import {
  getSupabaseAuthCookieNames,
  withholdSupabaseSessionCredentials,
  type CookieValue,
} from "@/lib/auth/session-cookie";
import { createSupabaseServerClient } from "./client-config";
import { type CookieToSet } from "./types";

function createResponseClient(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  effectiveCookies: Map<string, string>,
) {
  const cookiesToApply: CookieToSet[] = [];
  const headersToApply: Record<string, string> = {};

  const supabase = createSupabaseServerClient(
    {
      getAll() {
        return Array.from(effectiveCookies, ([name, value]) => ({
          name,
          value,
        }));
      },
      setAll(
        nextCookiesToSet: CookieToSet[],
        headers?: Record<string, string>,
      ) {
        nextCookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
          effectiveCookies.set(name, value);
          cookiesToApply.push({ name, value, options });
        });
        if (headers) {
          Object.assign(headersToApply, headers);
        }
      },
    },
    "Supabase auth operation timed out",
  );

  function applyCookies(
    response: NextResponse,
    effect: SessionEffect = { kind: "Preserve" },
  ): NextResponse {
    Object.entries(headersToApply).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    const [firstCookie, ...remainingCookies] = cookiesToApply;
    if (effect.kind === "Clear" || !firstCookie) {
      return finalizeSessionResponse(response, effect);
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
            ],
          }
        : { kind: "Rotate", cookiesToSet: providerCookies };
    return finalizeSessionResponse(response, combinedEffect);
  }

  return {
    supabase,
    applyCookies,
    clearSession(response: NextResponse): NextResponse {
      return applyCookies(response, {
        kind: "Clear",
        cookieNames: getSupabaseAuthCookieNames(
          Array.from(effectiveCookies, ([name, value]) => ({ name, value })),
        ),
        feedback: false,
      });
    },
  };
}

export async function createSessionEstablishmentClient() {
  const cookieStore = await cookies();
  return createResponseClient(
    cookieStore,
    new Map(
      withholdSupabaseSessionCredentials(cookieStore.getAll()).map(
        ({ name, value }) => [name, value],
      ),
    ),
  );
}

export async function createCurrentSessionClient(
  initialCookies: readonly CookieValue[] = [],
) {
  const cookieStore = await cookies();
  const effectiveCookies = new Map(
    cookieStore.getAll().map(({ name, value }) => [name, value]),
  );
  for (const { name, value } of initialCookies) {
    effectiveCookies.set(name, value);
  }
  return createResponseClient(cookieStore, effectiveCookies);
}
