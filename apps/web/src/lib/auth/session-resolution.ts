import { NextResponse } from "next/server";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { getSessionVerification } from "@/lib/auth/dal";
import { refreshSession } from "@/lib/auth/refresh";
import {
  AuthDependencyError,
  finalizeSessionResponse,
  type SessionEffect,
} from "@/lib/auth/session-response";

function resolveSessionRequestOrigin(request: Request): string | null {
  try {
    return resolveCallbackRedirectOrigin(request);
  } catch {
    return null;
  }
}

function isSameOriginSessionResolution(
  request: Request,
  expectedOrigin: string,
): boolean {
  return (
    request.headers.get("origin") === expectedOrigin &&
    request.headers.get("x-nexus-session") === "Resolve"
  );
}

function response(status: number, effect: SessionEffect): NextResponse {
  return finalizeSessionResponse(new NextResponse(null, { status }), effect);
}

export interface SessionResolutionDeps {
  readonly verifySession: typeof getSessionVerification;
  readonly refreshSession: typeof refreshSession;
}

export async function postSessionResolutionWithDeps(
  request: Request,
  deps: SessionResolutionDeps,
): Promise<NextResponse> {
  const expectedOrigin = resolveSessionRequestOrigin(request);
  if (!expectedOrigin) {
    return response(500, { kind: "Preserve" });
  }
  if (!isSameOriginSessionResolution(request, expectedOrigin)) {
    return response(403, { kind: "Preserve" });
  }

  try {
    const verification = await deps.verifySession();
    switch (verification.kind) {
      case "Verified":
        return response(204, { kind: "Preserve" });
      case "Anonymous":
        return response(401, { kind: "Preserve" });
      case "SessionEnded":
        return response(401, {
          kind: "Clear",
          cookieNames: verification.cookieNames,
          feedback: true,
        });
      case "RefreshRequired": {
        try {
          const refreshed = await deps.refreshSession();
          switch (refreshed.kind) {
            case "Refreshed":
              return response(204, {
                kind: "Rotate",
                cookiesToSet: refreshed.cookiesToSet,
              });
            case "SessionEnded":
              return response(401, {
                kind: "Clear",
                cookieNames: refreshed.cookieNames,
                feedback: true,
              });
          }

          refreshed satisfies never;
        } catch (error) {
          if (error instanceof AuthDependencyError) {
            const unavailable = response(503, { kind: "Preserve" });
            unavailable.headers.set("Retry-After", "3");
            return unavailable;
          }
          throw error;
        }
      }
    }

    verification satisfies never;
  } catch (error) {
    if (error instanceof AuthDependencyError) {
      const unavailable = response(503, { kind: "Preserve" });
      unavailable.headers.set("Retry-After", "3");
      return unavailable;
    }
    return response(500, { kind: "Preserve" });
  }
}

export async function postSessionResolution(
  request: Request,
): Promise<NextResponse> {
  return postSessionResolutionWithDeps(request, {
    verifySession: getSessionVerification,
    refreshSession,
  });
}
