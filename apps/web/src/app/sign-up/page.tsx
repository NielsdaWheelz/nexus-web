import { redirect } from "next/navigation";
import {
  buildLoginUrl,
  getFirstSearchParamValue,
  parseAuthReturnTarget,
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
  const target = buildLoginUrl(
    "http://localhost",
    parseAuthReturnTarget(getFirstSearchParamValue(params.next)),
    { mode: "create" }
  );
  redirect(`${target.pathname}${target.search}`);
}
