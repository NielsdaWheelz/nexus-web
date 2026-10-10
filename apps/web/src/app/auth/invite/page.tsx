import type { Metadata } from "next";
import EmailActionLanding from "@/components/auth/EmailActionLanding";
import { firstParam } from "@/lib/auth/urls";

export const metadata: Metadata = {
  title: "Accept invitation · Nexus",
  robots: { index: false, follow: false },
};

// inert: the token is spent only by the landing's POST.
export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string | string[] }>;
}) {
  const tokenHash = firstParam((await searchParams).token_hash)?.trim();
  return <EmailActionLanding purpose="invite" tokenHash={tokenHash || null} />;
}
