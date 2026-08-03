import { NextResponse } from "next/server";
import {
  PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  PASSWORD_SIGN_UP_FAILURE_MESSAGE,
} from "@/lib/auth/messages";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { noStore } from "@/lib/auth/no-store";
import {
  DEFAULT_AUTH_RETURN_TARGET,
  type AuthReturnTarget,
  buildAuthReturnTargetUrl,
  buildLoginUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import {
  signInWithPasswordFlow,
  signUpWithPasswordFlow,
} from "@/lib/auth/password-flow";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";

export const runtime = "nodejs";

const SEE_OTHER = 303;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function forbidden(): NextResponse {
  return noStore(new NextResponse("Forbidden", { status: 403 }));
}

function isSameOriginFormPost(request: Request, redirectOrigin: string): boolean {
  return request.headers.get("origin") === redirectOrigin;
}

function redirectToLogin(
  redirectOrigin: string,
  {
    mode,
    target,
    error,
  }: {
    mode: "signin" | "create";
    target: AuthReturnTarget;
    error: string;
  },
): NextResponse {
  const loginUrl = buildLoginUrl(redirectOrigin, target, {
    mode: mode === "create" ? "create" : undefined,
    errorDescription: error,
  });
  return noStore(NextResponse.redirect(loginUrl, { status: SEE_OTHER }));
}

export async function POST(request: Request): Promise<NextResponse> {
  const redirectOrigin = resolveCallbackRedirectOrigin(request);
  if (!isSameOriginFormPost(request, redirectOrigin)) {
    return forbidden();
  }

  const formData = await request.formData();
  const mode = formString(formData, "mode") === "create" ? "create" : "signin";
  const target = parseAuthReturnTarget(formString(formData, "next"));
  const email = formString(formData, "email");
  const password = formString(formData, "password");
  const displayName = formString(formData, "display_name");
  const auth = await createRouteHandlerClient();

  if (mode === "signin") {
    const result = await signInWithPasswordFlow(auth.supabase, {
      email,
      password,
    });
    if (!result.ok) {
      return redirectToLogin(redirectOrigin, {
        mode,
        target,
        error: result.error || PASSWORD_SIGN_IN_FAILURE_MESSAGE,
      });
    }

    await auth.settlePendingCookieWrites();
    const response = NextResponse.redirect(
      buildAuthReturnTargetUrl(redirectOrigin, target),
      { status: SEE_OTHER },
    );
    return auth.applyCookies(noStore(response));
  }

  const result = await signUpWithPasswordFlow(auth.supabase, {
    email,
    password,
    displayName,
  });
  if (!result.ok) {
    return redirectToLogin(redirectOrigin, {
      mode,
      target,
      error: result.error || PASSWORD_SIGN_UP_FAILURE_MESSAGE,
    });
  }

  await auth.settlePendingCookieWrites();
  const response = NextResponse.redirect(
    buildAuthReturnTargetUrl(redirectOrigin, DEFAULT_AUTH_RETURN_TARGET),
    { status: SEE_OTHER },
  );
  return auth.applyCookies(noStore(response));
}
