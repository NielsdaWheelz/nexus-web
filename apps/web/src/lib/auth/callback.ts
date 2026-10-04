import { NextResponse } from "next/server";
import {
  buildAuthReturnTargetUrl,
  buildAuthHandoffErrorDeepLink,
  buildAuthHandoffSuccessDeepLink,
  buildLoginUrl,
  parseAuthReturnTarget,
} from "./redirects";
import { resolveCallbackRedirectOrigin } from "./callback-origin";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
  projectOAuthCallbackError,
} from "./messages";
import { mintHandoffCode } from "./mint-handoff-code";
import { createSessionEstablishmentClient } from "@/lib/supabase/route-handler";

const TEMPORARY_REDIRECT = 307;

export async function handleAuthCallback(request: Request): Promise<NextResponse> {
  const auth = await createSessionEstablishmentClient();
  try {
    const requestUrl = new URL(request.url);
    const target = parseAuthReturnTarget(requestUrl.searchParams.get("next"));
    const redirectOrigin = resolveCallbackRedirectOrigin(request);
    const isHandoff = requestUrl.searchParams.get("flow") === "handoff";
    const providerErrorCode = requestUrl.searchParams.get("error");
    const hasProviderError =
      providerErrorCode !== null ||
      requestUrl.searchParams.has("error_description");

    if (hasProviderError) {
      const publicError = projectOAuthCallbackError(providerErrorCode);
      if (isHandoff) {
        const handoffErrorCode =
          publicError === AUTH_CALLBACK_CANCELLED_MESSAGE
            ? "oauth_user_cancelled"
            : "oauth_provider_error";
        return auth.applyCookies(
          NextResponse.redirect(
            new URL(buildAuthHandoffErrorDeepLink(handoffErrorCode, target)),
            { status: TEMPORARY_REDIRECT },
          ),
        );
      }
      return auth.applyCookies(
        NextResponse.redirect(
          buildLoginUrl(redirectOrigin, target, {
            errorDescription: publicError,
          }),
        ),
      );
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      if (isHandoff) {
        return auth.applyCookies(
          NextResponse.redirect(
            new URL(
              buildAuthHandoffErrorDeepLink("oauth_callback_missing_code", target),
            ),
            { status: TEMPORARY_REDIRECT },
          ),
        );
      }
      return auth.applyCookies(
        NextResponse.redirect(
          buildLoginUrl(redirectOrigin, target, {
            errorDescription: AUTH_CALLBACK_FAILURE_MESSAGE,
          }),
        ),
      );
    }

    const exchangeFailure = () =>
      auth.applyCookies(
        isHandoff
          ? NextResponse.redirect(
              new URL(
                buildAuthHandoffErrorDeepLink("handoff_exchange_failed", target),
              ),
              { status: TEMPORARY_REDIRECT },
            )
          : NextResponse.redirect(
              buildLoginUrl(redirectOrigin, target, {
                errorDescription: AUTH_CALLBACK_FAILURE_MESSAGE,
              }),
            ),
      );

    let result: Awaited<
      ReturnType<typeof auth.supabase.auth.exchangeCodeForSession>
    >;
    try {
      result = await auth.supabase.auth.exchangeCodeForSession(code);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      // justify-ignore-error: exchange failures retain the existing generic
      // callback failure surface without exposing provider details.
      return exchangeFailure();
    }
    if (result.error) {
      return exchangeFailure();
    }

    if (isHandoff) {
      const session = result.data.session;
      if (!session) {
        return exchangeFailure();
      }
      const hc = requestUrl.searchParams.get("hc") ?? "";
      try {
        const mintResult = await mintHandoffCode({
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          challenge: hc,
        });
        if ("error" in mintResult) {
          return auth.clearSession(
            NextResponse.redirect(
              new URL(buildAuthHandoffErrorDeepLink("handoff_mint_failed", target)),
              { status: TEMPORARY_REDIRECT },
            ),
          );
        }
        return auth.applyCookies(
          NextResponse.redirect(
            new URL(buildAuthHandoffSuccessDeepLink(mintResult.code, target)),
            { status: TEMPORARY_REDIRECT },
          ),
        );
      } catch {
        // justify-defect: any failure after establishment must return cleanup
        // with the existing internal-error response, including non-Error throws.
        return auth.clearSession(
          new NextResponse(AUTH_CALLBACK_FAILURE_MESSAGE, { status: 500 }),
        );
      }
    }

    return auth.applyCookies(
      NextResponse.redirect(buildAuthReturnTargetUrl(redirectOrigin, target)),
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return auth.applyCookies(
      new NextResponse(AUTH_CALLBACK_FAILURE_MESSAGE, { status: 500 }),
    );
  }
}
