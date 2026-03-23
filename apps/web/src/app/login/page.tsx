import { redirect } from "next/navigation";
import {
  DEFAULT_AUTH_REDIRECT,
  getFirstSearchParamValue,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { toPublicAuthErrorMessage } from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";
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
  const initialError = toPublicAuthErrorMessage(
    getFirstSearchParamValue(params.error_description) ??
      getFirstSearchParamValue(params.error)
  );

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect(nextPath);
  }

  return <LoginPageClient initialError={initialError} nextPath={nextPath} />;
}
