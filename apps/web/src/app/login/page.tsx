import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import {
  getSessionVerification,
  type SessionVerification,
} from "@/lib/auth/dal";
import { AuthDependencyError } from "@/lib/auth/session-response";
import {
  buildAuthSessionRecoveryUrl,
  getFirstSearchParamValue,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import {
  AUTH_ENDED_FEEDBACK_COOKIE,
  readPublicAuthFeedback,
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/messages";
import { getEnv } from "@/lib/env";
import LoginPageClient from "./LoginPageClient";

interface LoginPageProps {
  searchParams: Promise<{
    error?: string | string[];
    error_description?: string | string[];
    next?: string | string[];
  }>;
}

export const metadata: Metadata = {
  title: "Sign in · Nexus",
  robots: { index: false, follow: false },
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const nextPath = parseAuthReturnTarget(getFirstSearchParamValue(params.next));
  const recover = (): never => {
    const recoveryUrl = buildAuthSessionRecoveryUrl(
      getEnv().appPublicOrigin,
      nextPath,
    );
    redirect(`${recoveryUrl.pathname}${recoveryUrl.search}`);
  };

  let verification: SessionVerification;
  try {
    verification = await getSessionVerification();
  } catch (error) {
    if (!(error instanceof AuthDependencyError)) {
      throw error;
    }
    return recover();
  }

  switch (verification.kind) {
    case "Verified":
      redirect(nextPath);
    case "RefreshRequired":
    case "SessionEnded":
      recover();
    case "Anonymous":
      break;
    default:
      verification satisfies never;
  }

  const cookieStore = await cookies();
  const sessionEndedFeedbackCookie =
    cookieStore.get(AUTH_ENDED_FEEDBACK_COOKIE)?.value === "1";
  const initialFeedbackMessage = readPublicAuthFeedback(
    getFirstSearchParamValue(params.error_description) ??
      getFirstSearchParamValue(params.error) ??
      (sessionEndedFeedbackCookie ? SESSION_ENDED_MESSAGE : null),
  );

  const isShell = isAndroidShellUserAgent(
    (await headers()).get("user-agent") ?? "",
  );

  return (
    <LoginPageClient
      initialFeedbackMessage={initialFeedbackMessage}
      nextPath={nextPath}
      isShell={isShell}
    />
  );
}
