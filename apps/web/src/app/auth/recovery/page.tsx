import type { Metadata } from "next";
import EmailActionLanding from "@/components/auth/EmailActionLanding";
import { parseEmailConfirmationToken } from "@/lib/auth/email-confirmation";

export const metadata: Metadata = {
  title: "Reset your password · Nexus",
  robots: { index: false, follow: false },
};

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = parseEmailConfirmationToken({ tokenHash: params.token_hash });
  return (
    <EmailActionLanding
      purpose="recovery"
      tokenHash={token.kind === "Valid" ? token.tokenHash : null}
    />
  );
}
