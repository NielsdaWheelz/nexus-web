import { cookies, headers } from "next/headers";
import { type FeedbackContent } from "@/components/feedback/Feedback";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import {
  getFirstSearchParamValue,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import {
  AUTH_ENDED_FEEDBACK_COOKIE,
  readPublicAuthFeedback,
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/messages";
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
function toInitialFeedback(message: string | null): {
  content: FeedbackContent;
  announcement: "Polite" | "Assertive";
} | null {
  if (!message) {
    return null;
  }
  if (message === SESSION_ENDED_MESSAGE) {
    return {
      content: { tone: "Info", title: "You were signed out.", message },
      announcement: "Polite",
    };
  }
  return {
    content: { tone: "Danger", title: message },
    announcement: "Assertive",
  };
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const nextPath = parseAuthReturnTarget(getFirstSearchParamValue(params.next));

  const cookieStore = await cookies();
  const sessionEndedFeedbackCookie =
    cookieStore.get(AUTH_ENDED_FEEDBACK_COOKIE)?.value === "1";
  const initialFeedback = toInitialFeedback(
    readPublicAuthFeedback(
      getFirstSearchParamValue(params.error_description) ??
        getFirstSearchParamValue(params.error) ??
        (sessionEndedFeedbackCookie ? SESSION_ENDED_MESSAGE : null)
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
