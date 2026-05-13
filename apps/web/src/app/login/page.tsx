import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  DEFAULT_AUTH_REDIRECT,
  getFirstSearchParamValue,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { toPublicAuthErrorMessage } from "@/lib/auth/messages";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import LoginPageClient from "./LoginPageClient";

interface LoginPageProps {
  searchParams: Promise<{
    error?: string | string[];
    error_description?: string | string[];
    next?: string | string[];
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const nextPath = normalizeAuthRedirect(
    getFirstSearchParamValue(params.next),
    DEFAULT_AUTH_REDIRECT
  );
  if (readSupabaseSessionCookie((await cookies()).getAll()).ok) {
    redirect(nextPath);
  }

  const initialError = toPublicAuthErrorMessage(
    getFirstSearchParamValue(params.error_description) ??
      getFirstSearchParamValue(params.error)
  );

  return <LoginPageClient initialError={initialError} nextPath={nextPath} />;
}
