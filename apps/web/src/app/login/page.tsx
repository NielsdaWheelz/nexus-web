import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { type FeedbackContent } from "@/components/feedback/Feedback";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import {
  getFirstSearchParamValue,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import {
  AUTH_ENDED_FEEDBACK_COOKIE,
  SESSION_ENDED_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import LoginPageClient from "./LoginPageClient";

interface LoginPageProps {
  searchParams: Promise<{
    error?: string | string[];
    error_description?: string | string[];
    mode?: string | string[];
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
  const nextPath = parseAuthReturnTarget(getFirstSearchParamValue(params.next));

  const cookieStore = await cookies();
  const requestCookies = cookieStore.getAll();
  const session = readSupabaseSessionCookie(requestCookies);
  if (session.state === "active") {
    redirect(nextPath);
  }

  const sessionEndedFeedbackCookie =
    cookieStore.get(AUTH_ENDED_FEEDBACK_COOKIE)?.value === "1";
  const initialFeedback = toInitialFeedback(
    toPublicAuthErrorMessage(
      getFirstSearchParamValue(params.error_description) ??
        getFirstSearchParamValue(params.error) ??
        (sessionEndedFeedbackCookie ? SESSION_ENDED_MESSAGE : null)
    )
  );

  const isShell = isAndroidShellUserAgent(
    (await headers()).get("user-agent") ?? ""
  );

  // `?mode=create` opens the page in create-account mode. /sign-up redirects
  // here with that param. Any other value (or omission) falls through to
  // sign-in, which is the page's default.
  const initialMode =
    getFirstSearchParamValue(params.mode) === "create" ? "create" : "signin";

  return (
    <LoginPageClient
      initialFeedback={initialFeedback}
      initialMode={initialMode}
      nextPath={nextPath}
      isShell={isShell}
    />
  );
}
