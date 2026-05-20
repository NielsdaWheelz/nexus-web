import { handleAuthCallback } from "@/lib/auth/callback";
import { AUTH_CALLBACK_FAILURE_MESSAGE } from "@/lib/auth/messages";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { NextResponse } from "next/server";

const HANDOFF_MINT_DEADLINE_MS = 5_000;

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
        const fastApiBaseUrl =
          process.env.FASTAPI_BASE_URL ||
          (process.env.NODE_ENV === "production" ? "" : "http://localhost:8000");
        if (!fastApiBaseUrl) {
          return { error: "not_configured" };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort(
            new DOMException("Handoff mint request timed out", "AbortError")
          );
        }, HANDOFF_MINT_DEADLINE_MS);

        let response: Response;
        try {
          response = await fetch(`${fastApiBaseUrl}/auth/handoff-codes`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              access_token: accessToken,
              refresh_token: refreshToken,
              challenge,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          // justify-ignore-error: a timed-out or failed mint surfaces as a
          // single "handoff_mint_failed" deep link on the callback side.
          return { error: "fetch_failed" };
        } finally {
          clearTimeout(timeoutId);
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
