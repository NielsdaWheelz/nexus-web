import { NextResponse } from "next/server";
import { createExtensionSession } from "@/lib/auth/internal";
import { finish, getVerification, redirectTo } from "@/lib/auth/session";
import { loginPath, parseReturnTarget, recoverPath } from "@/lib/auth/urls";
import { createRandomId } from "@/lib/createRandomId";
import { getEnv } from "@/lib/env";
import { AuthUnavailable } from "@/lib/supabase/auth";

const invalid = (message: string, code = "E_INVALID_REQUEST", status = 400) =>
  finish(NextResponse.json({ error: { code, message } }, { status }));

// the firefox extension's sign-in: a signed-in viewer is handed an extension
// session at the extension's own redirect origin, as
// #token=…[&state] or #error=session_failed&request_id=…[&state].
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const raw = url.searchParams.get("redirect_uri");
  if (!raw) return invalid("redirect_uri is required");
  if (!URL.canParse(raw)) return invalid("redirect_uri is invalid");
  const redirectUri = new URL(raw);
  // the extension's per-flow correlation value, echoed beside the outcome.
  const state = url.searchParams.get("state");
  if (state !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(state)) {
    return invalid("state is invalid");
  }
  if (
    redirectUri.protocol !== "https:" ||
    redirectUri.origin !== getEnv().extensionRedirectOrigin
  ) {
    return invalid(
      "Extension redirect origin is not allowed",
      "E_FORBIDDEN",
      403,
    );
  }

  // a signed-out viewer signs in and comes back here; an unresolved session
  // resolves first.
  const target = parseReturnTarget(`${url.pathname}${url.search}`);
  let verification;
  try {
    verification = await getVerification();
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    return finish(redirectTo(recoverPath(target)));
  }
  if (verification.kind === "Anonymous") {
    return finish(redirectTo(loginPath(target)));
  }
  if (verification.kind !== "Verified") {
    return finish(redirectTo(recoverPath(target)));
  }

  const requestId = createRandomId();
  const token = await createExtensionSession(
    verification.accessToken,
    requestId,
  );
  const outcome: Record<string, string> = token
    ? { token }
    : { error: "session_failed", request_id: requestId };
  redirectUri.hash = new URLSearchParams(
    state === null ? outcome : { ...outcome, state },
  ).toString();
  return finish(NextResponse.redirect(redirectUri));
}
