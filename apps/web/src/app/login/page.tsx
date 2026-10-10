import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import { ENDED_FEEDBACK_COOKIE, getVerification } from "@/lib/auth/session";
import { firstParam, parseReturnTarget, recoverPath } from "@/lib/auth/urls";
import { AuthUnavailable } from "@/lib/supabase/auth";
import LoginPageClient from "./LoginPageClient";

export const metadata: Metadata = {
  title: "Sign in · Nexus",
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    next?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const nextPath = parseReturnTarget(firstParam(params.next));
  // a viewer with a session never sees the form: verified goes on, anything
  // unresolved goes through the resolver (which clears an ended session).
  let kind;
  try {
    kind = (await getVerification()).kind;
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    kind = "RefreshRequired";
  }
  if (kind === "Verified") redirect(nextPath);
  if (kind !== "Anonymous") redirect(recoverPath(nextPath));

  const error = firstParam(params.error);
  const ended = (await cookies()).get(ENDED_FEEDBACK_COOKIE)?.value === "1";
  return (
    <LoginPageClient
      feedback={
        error === "oauth_start_failed" || error === "sign_in_failed"
          ? error
          : ended
            ? "session_ended"
            : null
      }
      nextPath={nextPath}
      isShell={isAndroidShellUserAgent(
        (await headers()).get("user-agent") ?? "",
      )}
    />
  );
}
