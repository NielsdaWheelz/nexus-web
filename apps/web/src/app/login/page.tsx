import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { type FeedbackContent } from "@/components/feedback/Feedback";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import {
  DEFAULT_AUTH_REDIRECT,
  getFirstSearchParamValue,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import {
  SESSION_ENDED_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import LoginPageClient from "./LoginPageClient";

interface LoginPageProps {
  searchParams: Promise<{
    error?: string | string[];
    error_description?: string | string[];
    next?: string | string[];
  }>;
}

// A forced sign-out is a calm, expected state, not an error; an OAuth failure
// is an error. The message text is the discriminant.
function toInitialFeedback(message: string | null): FeedbackContent | null {
  if (!message) {
    return null;
  }
  if (message === SESSION_ENDED_MESSAGE) {
    return { severity: "info", title: "You were signed out.", message };
  }
  return { severity: "error", title: message };
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const nextPath = normalizeAuthRedirect(
    getFirstSearchParamValue(params.next),
    DEFAULT_AUTH_REDIRECT
  );

  const session = readSupabaseSessionCookie((await cookies()).getAll());
  if (session.state === "active") {
    redirect(nextPath);
  }

  const initialFeedback = toInitialFeedback(
    toPublicAuthErrorMessage(
      getFirstSearchParamValue(params.error_description) ??
        getFirstSearchParamValue(params.error)
    )
  );

  const isShell = isAndroidShellUserAgent(
    (await headers()).get("user-agent") ?? ""
  );

  return (
    <LoginPageClient
      initialFeedback={initialFeedback}
      nextPath={nextPath}
      isShell={isShell}
    />
  );
}
