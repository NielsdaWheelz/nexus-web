import { NextResponse } from "next/server";
import {
  DEFAULT_AUTH_REDIRECT,
  buildLoginUrlWithError,
  normalizeAuthRedirect,
} from "./redirects";
import { resolveCallbackRedirectOrigin } from "./callback-origin";
import {
  AUTH_CALLBACK_FAILURE_MESSAGE,
  toPublicAuthErrorMessage,
} from "./messages";

export interface AuthCallbackDeps {
  exchangeCodeForSession: (
    code: string
  ) => Promise<{ error: { message: string } | null }>;
}

export async function handleAuthCallback(
  request: Request,
  deps: AuthCallbackDeps
): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const nextPath = normalizeAuthRedirect(
    requestUrl.searchParams.get("next"),
    DEFAULT_AUTH_REDIRECT
  );
  const redirectOrigin = resolveCallbackRedirectOrigin(request, requestUrl);
  const providerError =
    requestUrl.searchParams.get("error_description") ??
    requestUrl.searchParams.get("error");

  if (providerError) {
    const publicError =
      toPublicAuthErrorMessage(providerError) ?? AUTH_CALLBACK_FAILURE_MESSAGE;
    return NextResponse.redirect(
      buildLoginUrlWithError(redirectOrigin, nextPath, publicError)
    );
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      buildLoginUrlWithError(
        redirectOrigin,
        nextPath,
        AUTH_CALLBACK_FAILURE_MESSAGE
      )
    );
  }

  const { error } = await deps.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      buildLoginUrlWithError(
        redirectOrigin,
        nextPath,
        AUTH_CALLBACK_FAILURE_MESSAGE
      )
    );
  }

  return NextResponse.redirect(new URL(nextPath, redirectOrigin));
}
