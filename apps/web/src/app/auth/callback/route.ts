import {
  getInternalApiConfig,
  isInternalApiConfigured,
} from "@/lib/api/internal-config";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { handleAuthCallback } from "@/lib/auth/callback";
import { AUTH_CALLBACK_FAILURE_MESSAGE } from "@/lib/auth/messages";
import { createRandomId } from "@/lib/createRandomId";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { supabase, applyCookies, settlePendingCookieWrites } =
    await createRouteHandlerClient();
  try {
    const response = await handleAuthCallback(request, {
      exchangeCodeForSession: async (code) => {
        try {
          const result = await supabase.auth.exchangeCodeForSession(code);
          await settlePendingCookieWrites();
          return {
            data: { session: result.data.session ?? null },
            error: result.error
              ? { message: result.error.message }
              : null,
          };
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          return {
            data: { session: null },
            error: { message: AUTH_CALLBACK_FAILURE_MESSAGE },
          };
        }
      },
      mintHandoffCode: async ({ accessToken, refreshToken, challenge }) => {
        const config = getInternalApiConfig();
        if (!isInternalApiConfigured(config)) {
          return { error: "not_configured" };
        }

        const requestId = createRandomId();

        let response: Response;
        try {
          response = await boundedAuthFetch(
            `${config.fastApiBaseUrl}/auth/handoff-codes`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "X-Request-ID": requestId,
                ...(config.internalSecret
                  ? { "X-Nexus-Internal": config.internalSecret }
                  : {}),
              },
              body: JSON.stringify({
                access_token: accessToken,
                refresh_token: refreshToken,
                challenge,
              }),
            },
            "Handoff mint request timed out",
          );
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          // justify-ignore-error: a timed-out or failed mint surfaces as a
          // single "handoff_mint_failed" deep link on the callback side.
          return { error: "fetch_failed" };
        }

        if (!response.ok) {
          return { error: "non_2xx" };
        }

        const body = await response.json();
        const code = body?.data?.code;
        if (typeof code !== "string" || !code) {
          return { error: "malformed_response" };
        }
        return { code };
      },
    });

    return applyCookies(response);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return applyCookies(
      new NextResponse(AUTH_CALLBACK_FAILURE_MESSAGE, {
        status: 500,
      })
    );
  }
}
