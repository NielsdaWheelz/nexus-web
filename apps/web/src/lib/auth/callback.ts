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

interface AuthCallbackDeps {
  exchangeCodeForSession: (code: string) => Promise<{
    data: { session: { access_token: string; refresh_token: string } | null };
    error: { message: string } | null;
  }>;
  mintHandoffCode: (args: {
    accessToken: string;
    refreshToken: string;
    challenge: string;
  }) => Promise<{ code: string } | { error: string }>;
}

const TEMPORARY_REDIRECT = 307;

export async function handleAuthCallback(
  request: Request,
  deps: AuthCallbackDeps,
): Promise<NextResponse> {
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
      return NextResponse.redirect(
        new URL(buildAuthHandoffErrorDeepLink(handoffErrorCode, target)),
        { status: TEMPORARY_REDIRECT },
      );
    }
    return NextResponse.redirect(
      buildLoginUrl(redirectOrigin, target, {
        errorDescription: publicError,
      }),
    );
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    if (isHandoff) {
      return NextResponse.redirect(
        new URL(
          buildAuthHandoffErrorDeepLink("oauth_callback_missing_code", target),
        ),
        { status: TEMPORARY_REDIRECT },
      );
    }
    return NextResponse.redirect(
      buildLoginUrl(redirectOrigin, target, {
        errorDescription: AUTH_CALLBACK_FAILURE_MESSAGE,
      }),
    );
  }

  const { data, error } = await deps.exchangeCodeForSession(code);
  if (error) {
    if (isHandoff) {
      return NextResponse.redirect(
        new URL(
          buildAuthHandoffErrorDeepLink("handoff_exchange_failed", target),
        ),
        { status: TEMPORARY_REDIRECT },
      );
    }
    return NextResponse.redirect(
      buildLoginUrl(redirectOrigin, target, {
        errorDescription: AUTH_CALLBACK_FAILURE_MESSAGE,
      }),
    );
  }

  if (isHandoff) {
    const session = data.session;
    if (!session) {
      return NextResponse.redirect(
        new URL(
          buildAuthHandoffErrorDeepLink("handoff_exchange_failed", target),
        ),
        { status: TEMPORARY_REDIRECT },
      );
    }
    const hc = requestUrl.searchParams.get("hc") ?? "";
    const mintResult = await deps.mintHandoffCode({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      challenge: hc,
    });
    if ("error" in mintResult) {
      return NextResponse.redirect(
        new URL(buildAuthHandoffErrorDeepLink("handoff_mint_failed", target)),
        { status: TEMPORARY_REDIRECT },
      );
    }
    return NextResponse.redirect(
      new URL(buildAuthHandoffSuccessDeepLink(mintResult.code, target)),
      { status: TEMPORARY_REDIRECT },
    );
  }

  return NextResponse.redirect(
    buildAuthReturnTargetUrl(redirectOrigin, target),
  );
}
