import { redirect } from "next/navigation";
import {
  DEFAULT_AUTH_REDIRECT,
  getFirstSearchParamValue,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";

interface SignUpPageProps {
  searchParams: Promise<{
    next?: string | string[];
  }>;
}

// /sign-up exists only for inbound links (bookmarks, marketing surfaces, the
// pre-redesign "Create account" link in the wild). The page itself is the
// /login route in create-account mode; this is a permanent server redirect so
// the address bar reflects the single auth surface.
export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = await searchParams;
  const nextPath = normalizeAuthRedirect(
    getFirstSearchParamValue(params.next),
    DEFAULT_AUTH_REDIRECT
  );
  const target =
    nextPath === DEFAULT_AUTH_REDIRECT
      ? "/login?mode=create"
      : `/login?mode=create&next=${encodeURIComponent(nextPath)}`;
  redirect(target);
}
