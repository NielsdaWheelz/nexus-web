import { handleAuthCallback } from "@/lib/auth/callback";
import { AUTH_CALLBACK_FAILURE_MESSAGE } from "@/lib/auth/messages";
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
          return result;
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          return { error: { message: AUTH_CALLBACK_FAILURE_MESSAGE } };
        }
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
