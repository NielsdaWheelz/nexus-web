import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import { getSessionVerification } from "@/lib/auth/dal";
import { planLoginEntry } from "@/lib/auth/login-entry";
import {
  authReturnTargetToHref,
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
  const entry = await planLoginEntry(nextPath, getSessionVerification);

  switch (entry.kind) {
    case "Target":
      redirect(authReturnTargetToHref(entry.target));
    case "Recover": {
      const recoveryUrl = buildAuthSessionRecoveryUrl(
        getEnv().appPublicOrigin,
        entry.target,
      );
      redirect(`${recoveryUrl.pathname}${recoveryUrl.search}`);
    }
    case "Render":
      break;
    default:
      entry satisfies never;
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
