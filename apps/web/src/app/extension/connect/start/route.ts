import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertNever } from "@/lib/assertNever";
import { createExtensionSession } from "@/lib/auth/internal";
import {
  ended,
  finish,
  redirectTo,
  resolveEntry,
  type Effect,
  type LiveSession,
} from "@/lib/auth/session";
import { loginPath, parseReturnTarget, unavailablePath } from "@/lib/auth/urls";
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

  // this route owns resolution after validating the external destination.
  const target = parseReturnTarget(`${url.pathname}${url.search}`);
  let live: LiveSession;
  try {
    live = await resolveEntry((await cookies()).getAll());
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    return finish(redirectTo(unavailablePath(target), 303));
  }
  switch (live.kind) {
    case "Anonymous":
      return finish(redirectTo(loginPath(target), 303));
    case "Ended":
      return finish(redirectTo(loginPath(target), 303), ended(live.cookieNames));
    case "Live":
      break;
    default:
      return assertNever(live);
  }
  const effect: Effect = { kind: "Write", writes: live.writes };
  try {
    const requestId = createRandomId();
    const token = await createExtensionSession(live.accessToken, requestId);
    const outcome: Record<string, string> = token
      ? { token }
      : { error: "session_failed", request_id: requestId };
    redirectUri.hash = new URLSearchParams(
      state === null ? outcome : { ...outcome, state },
    ).toString();
    return finish(NextResponse.redirect(redirectUri), effect);
  } catch (error) {
    // containment still publishes a successor whose refresh token was spent.
    console.error("Extension session creation failed:", error);
    return finish(
      NextResponse.json(
        { error: { code: "E_INTERNAL", message: "Extension session creation failed" } },
        { status: 500 },
      ),
      effect,
    );
  }
}
