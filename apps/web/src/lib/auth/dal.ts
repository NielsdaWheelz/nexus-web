import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  buildLoginUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import {
  AuthDependencyError,
  isAuthDependencyFailure,
} from "@/lib/auth/session-response";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import { isAbortError } from "@/lib/errors";
import { createSessionVerifierClient } from "@/lib/supabase/server";

const VERIFY_DEADLINE_MS = 2_000;

export interface Viewer {
  userId: string;
  email: string | null;
}

export type SessionVerification =
  | { kind: "Verified"; viewer: Viewer }
  | { kind: "RefreshRequired" }
  | { kind: "SessionEnded"; cookieNames: readonly string[] }
  | { kind: "Anonymous" };

function rejectedActiveSession(
  canRefresh: boolean,
  cookieNames: readonly string[],
): SessionVerification {
  return canRefresh
    ? { kind: "RefreshRequired" }
    : { kind: "SessionEnded", cookieNames };
}

export const getSessionVerification = cache(
  async (): Promise<SessionVerification> => {
    const session = readSupabaseSessionCookie((await cookies()).getAll());

    switch (session.state) {
      case "active": {
        const supabase = await createSessionVerifierClient();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let result: Awaited<ReturnType<typeof supabase.auth.getClaims>>;
        try {
          result = await Promise.race([
            supabase.auth.getClaims(session.accessToken),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new AuthDependencyError()),
                VERIFY_DEADLINE_MS,
              );
            }),
          ]);
        } catch (error) {
          if (error instanceof AuthDependencyError) {
            throw error;
          }
          if (isAbortError(error) || isAuthDependencyFailure(error)) {
            throw new AuthDependencyError();
          }
          throw error;
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
        }

        if (result.error) {
          if (isAuthDependencyFailure(result.error)) {
            throw new AuthDependencyError();
          }
          if (
            result.error.name === "AuthInvalidJwtError" ||
            result.error.code === "invalid_jwt"
          ) {
            return rejectedActiveSession(
              session.canRefresh,
              session.cookieNames,
            );
          }
          // justify-defect: getClaims has one modeled credential-rejection
          // error; every other non-transient provider state is contract drift.
          throw new Error(
            `Unexpected Supabase verification error code: ${result.error.code ?? result.error.name}`,
          );
        }
        if (
          !result.data ||
          typeof result.data.claims.sub !== "string" ||
          result.data.claims.sub.length === 0
        ) {
          // justify-defect: successful verification must identify one subject.
          throw new Error("Supabase verification succeeded without a subject");
        }
        return {
          kind: "Verified",
          viewer: {
            userId: result.data.claims.sub,
            email:
              typeof result.data.claims.email === "string"
                ? result.data.claims.email
                : null,
          },
        };
      }
      case "refreshable":
        return { kind: "RefreshRequired" };
      case "ended":
        return { kind: "SessionEnded", cookieNames: session.cookieNames };
      case "anonymous":
        switch (session.reason) {
          case "missing":
            return { kind: "Anonymous" };
          case "malformed":
          case "non_bearer":
            return {
              kind: "SessionEnded",
              cookieNames: session.cookieNames,
            };
          case "bad_config":
            // justify-defect: authentication cannot classify cookies without
            // the configured provider project identity.
            throw new Error("Supabase auth cookie name is not configured");
        }
    }

    session satisfies never;
  },
);

async function redirectCarryingNext(
  target: "/login" | "/auth/session/recover",
): Promise<never> {
  const returnTarget = parseAuthReturnTarget(
    (await headers()).get(REQUEST_PATH_HEADER),
  );
  if (target === "/login") {
    const url = buildLoginUrl("http://localhost", returnTarget);
    redirect(`${url.pathname}${url.search}`);
  }
  redirect(`${target}?next=${encodeURIComponent(returnTarget)}`);
}

export async function verifySession(): Promise<Viewer> {
  let verification: SessionVerification;
  try {
    verification = await getSessionVerification();
  } catch (error) {
    if (!(error instanceof AuthDependencyError)) {
      throw error;
    }
    return redirectCarryingNext("/auth/session/recover");
  }

  switch (verification.kind) {
    case "Verified":
      return verification.viewer;
    case "Anonymous":
      return redirectCarryingNext("/login");
    case "RefreshRequired":
    case "SessionEnded":
      return redirectCarryingNext("/auth/session/recover");
  }

  verification satisfies never;
}
