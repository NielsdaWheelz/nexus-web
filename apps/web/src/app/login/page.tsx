import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { ENDED_FEEDBACK_COOKIE } from "@/lib/auth/session";
import { firstParam, parseHandoffContext, parseReturnTarget } from "@/lib/auth/urls";
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
    flow?: string | string[];
    hc?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const nextPath = parseReturnTarget(firstParam(params.next));
  const error = firstParam(params.error);
  const handoff = parseHandoffContext(firstParam(params.flow), firstParam(params.hc));
  if ((params.flow !== undefined || params.hc !== undefined) && handoff === null) notFound();
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
      handoff={handoff}
    />
  );
}
