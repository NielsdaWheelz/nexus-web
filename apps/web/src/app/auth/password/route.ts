import { NextResponse } from "next/server";
import {
  PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  PASSWORD_SIGN_UP_FAILURE_MESSAGE,
} from "@/lib/auth/messages";
import {
  DEFAULT_AUTH_REDIRECT,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import {
  signInWithPasswordFlow,
  signUpWithPasswordFlow,
} from "@/lib/auth/password-flow";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";

export const runtime = "nodejs";

const SEE_OTHER = 303;

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function forbidden(): NextResponse {
  return noStore(new NextResponse("Forbidden", { status: 403 }));
}

function isSameOriginFormPost(request: Request, requestUrl: URL): boolean {
  return request.headers.get("origin") === requestUrl.origin;
}

function redirectToLogin(
  requestUrl: URL,
  {
    mode,
    nextPath,
    error,
  }: {
    mode: "signin" | "create";
    nextPath: string;
    error: string;
  },
): NextResponse {
  const loginUrl = new URL("/login", requestUrl.origin);
  if (mode === "create") {
    loginUrl.searchParams.set("mode", "create");
  }
  if (nextPath !== DEFAULT_AUTH_REDIRECT) {
    loginUrl.searchParams.set("next", nextPath);
  }
  loginUrl.searchParams.set("error_description", error);
  return noStore(NextResponse.redirect(loginUrl, { status: SEE_OTHER }));
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  if (!isSameOriginFormPost(request, requestUrl)) {
    return forbidden();
  }

  const formData = await request.formData();
  const mode = formString(formData, "mode") === "create" ? "create" : "signin";
  const nextPath = normalizeAuthRedirect(
    formString(formData, "next"),
    DEFAULT_AUTH_REDIRECT,
  );
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
      return redirectToLogin(requestUrl, {
        mode,
        nextPath,
        error: result.error || PASSWORD_SIGN_IN_FAILURE_MESSAGE,
      });
    }

    await auth.settlePendingCookieWrites();
    const response = NextResponse.redirect(new URL(nextPath, requestUrl.origin), {
      status: SEE_OTHER,
    });
    return auth.applyCookies(noStore(response));
  }

  const result = await signUpWithPasswordFlow(auth.supabase, {
    email,
    password,
    displayName,
  });
  if (!result.ok) {
    return redirectToLogin(requestUrl, {
      mode,
      nextPath,
      error: result.error || PASSWORD_SIGN_UP_FAILURE_MESSAGE,
    });
  }

  await auth.settlePendingCookieWrites();
  const response = NextResponse.redirect(new URL(DEFAULT_AUTH_REDIRECT, requestUrl.origin), {
    status: SEE_OTHER,
  });
  return auth.applyCookies(noStore(response));
}
