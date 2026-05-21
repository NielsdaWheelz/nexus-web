import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import {
  DEFAULT_AUTH_REDIRECT,
  getFirstSearchParamValue,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import SignUpForm from "./SignUpForm";

export const metadata: Metadata = {
  title: "Create account | Nexus",
};

interface SignUpPageProps {
  searchParams: Promise<{
    next?: string | string[];
  }>;
}

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = await searchParams;
  const nextPath = normalizeAuthRedirect(
    getFirstSearchParamValue(params.next),
    DEFAULT_AUTH_REDIRECT
  );

  const session = readSupabaseSessionCookie((await cookies()).getAll());
  if (session.state === "active") {
    redirect(nextPath);
  }

  return <SignUpForm />;
}
