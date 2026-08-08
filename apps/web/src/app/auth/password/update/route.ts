import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { getSessionVerification } from "@/lib/auth/dal";
import {
  authFormFailure,
  readSameOriginAuthForm,
} from "@/lib/auth/form-response";
import { parsePasswordUpdateForm } from "@/lib/auth/form-fields";
import { updatePasswordFlow } from "@/lib/auth/password-flow";
import { refreshSession } from "@/lib/auth/refresh";
import {
  authReturnTargetToHref,
  isDefaultAuthReturnTarget,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import {
  AuthDependencyError,
  finalizeSessionResponse,
  type SessionEffect,
} from "@/lib/auth/session-response";
import { getSupabaseAuthCookieNames } from "@/lib/auth/session-cookie";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";

export const runtime = "nodejs";

function buildPasswordSurfaceUrl(
  origin: string,
  target: ReturnType<typeof parseAuthReturnTarget>,
  saved: boolean,
): URL {
  const url = new URL("/account/password", origin);
  if (saved) {
    url.searchParams.set("saved", "1");
  }
  if (!isDefaultAuthReturnTarget(target)) {
    url.searchParams.set("next", authReturnTargetToHref(target));
  }
  return url;
}

function sessionEndedResponse(effect: SessionEffect): NextResponse {
  return finalizeSessionResponse(
    NextResponse.json({ kind: "SessionEnded" }, { status: 401 }),
    effect,
  );
}

function internalResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: "E_INTERNAL", message: "Password update failed" } },
    { status: 500 },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const origin = resolveCallbackRedirectOrigin(request);
  if (request.headers.get("origin") !== origin) {
    return authFormFailure({
      body: { kind: "Forbidden" },
      status: 403,
    });
  }

  const requestCookieNames = getSupabaseAuthCookieNames(
    (await cookies()).getAll(),
  );
  let sessionEffect: SessionEffect = { kind: "Preserve" };
  let verification: Awaited<ReturnType<typeof getSessionVerification>>;
  try {
    verification = await getSessionVerification();
  } catch (error) {
    if (error instanceof AuthDependencyError) {
      return finalizeSessionResponse(
        authFormFailure({ body: { kind: "ServiceUnavailable" }, status: 503 }),
        sessionEffect,
      );
    }
    return finalizeSessionResponse(internalResponse(), sessionEffect);
  }

  switch (verification.kind) {
    case "Verified":
      break;
    case "Anonymous":
      return sessionEndedResponse(sessionEffect);
    case "SessionEnded":
      return sessionEndedResponse({
        kind: "Clear",
        cookieNames: verification.cookieNames,
        feedback: true,
      });
    case "RefreshRequired": {
      let refreshed: Awaited<ReturnType<typeof refreshSession>>;
      try {
        refreshed = await refreshSession();
      } catch (error) {
        if (error instanceof AuthDependencyError) {
          return finalizeSessionResponse(
            authFormFailure({ body: { kind: "ServiceUnavailable" }, status: 503 }),
            sessionEffect,
          );
        }
        return finalizeSessionResponse(internalResponse(), sessionEffect);
      }
      switch (refreshed.kind) {
        case "SessionEnded":
          return sessionEndedResponse({
            kind: "Clear",
            cookieNames: [
              ...new Set([
                ...requestCookieNames,
                ...refreshed.cookieNames,
              ]),
            ],
            feedback: true,
          });
        case "Refreshed":
          sessionEffect = {
            kind: "Rotate",
            cookiesToSet: refreshed.cookiesToSet,
          };
          break;
      }
      break;
    }
  }

  const requestForm = await readSameOriginAuthForm(request);
  if (requestForm.kind === "Rejected") {
    return finalizeSessionResponse(requestForm.response, sessionEffect);
  }

  const form = parsePasswordUpdateForm(requestForm.formData);
  if (!form || !form.password) {
    return finalizeSessionResponse(
      authFormFailure({ body: { kind: "InvalidRequest" }, status: 400 }),
      sessionEffect,
    );
  }

  const target = parseAuthReturnTarget(form.next);
  const auth = await createRouteHandlerClient(
    sessionEffect.kind === "Rotate" ? sessionEffect.cookiesToSet : [],
  );
  let outcome: Awaited<ReturnType<typeof updatePasswordFlow>>;
  try {
    outcome = await updatePasswordFlow({
      supabase: auth.supabase,
      password: form.password,
    });
    await auth.settlePendingCookieWrites();
  } catch {
    return auth.applyCookies(internalResponse(), sessionEffect);
  }

  switch (outcome.kind) {
    case "Saved":
      return auth.applyCookies(
        NextResponse.redirect(
          buildPasswordSurfaceUrl(requestForm.origin, target, true),
          { status: 303 },
        ),
        sessionEffect,
      );
    case "PolicyRejected":
      return auth.applyCookies(
        authFormFailure({ body: outcome, status: 400 }),
        sessionEffect,
      );
    case "SessionEnded":
      return auth.applyCookies(
        NextResponse.json({ kind: "SessionEnded" }, { status: 401 }),
        {
          kind: "Clear",
          cookieNames: [
            ...new Set([
              ...requestCookieNames,
              ...(sessionEffect.kind === "Rotate"
                ? sessionEffect.cookiesToSet.map(({ name }) => name)
                : []),
            ]),
          ],
          feedback: true,
        },
      );
    case "RateLimited":
      return auth.applyCookies(
        authFormFailure({ body: outcome, status: 429 }),
        sessionEffect,
      );
    case "ServiceUnavailable":
      return auth.applyCookies(
        authFormFailure({ body: outcome, status: 503 }),
        sessionEffect,
      );
  }

  outcome satisfies never;
}
