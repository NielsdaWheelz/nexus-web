import type { Metadata } from "next";
import EmailActionLanding from "@/components/auth/EmailActionLanding";
import { parseEmailConfirmationToken } from "@/lib/auth/email-confirmation";

export const metadata: Metadata = {
  title: "Accept invitation · Nexus",
  robots: { index: false, follow: false },
};

export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = parseEmailConfirmationToken({ tokenHash: params.token_hash });
  return (
    <EmailActionLanding
      purpose="invite"
      tokenHash={token.kind === "Valid" ? token.tokenHash : null}
    />
  );
}
