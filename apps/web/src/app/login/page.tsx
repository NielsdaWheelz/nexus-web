import {
  DEFAULT_AUTH_REDIRECT,
  getFirstSearchParamValue,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { toPublicAuthErrorMessage } from "@/lib/auth/messages";
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

  return <LoginPageClient initialError={initialError} nextPath={nextPath} />;
}
