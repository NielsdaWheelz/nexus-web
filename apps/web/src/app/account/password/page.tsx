import type { Metadata } from "next";
import BrowserAccountMismatch from "@/lib/auth/BrowserAccountMismatch";
import AuthSurface from "@/components/auth/AuthSurface";
import { verifySession } from "@/lib/auth/session";
import { expectedAccountPath, firstParam, parseReturnTarget } from "@/lib/auth/urls";
import PasswordUpdateForm from "./PasswordUpdateForm";

export const metadata: Metadata = {
  title: "Set or replace password · Nexus",
  robots: { index: false, follow: false },
};

export default async function AccountPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[];
    saved?: string | string[];
    expected_account_id?: string | string[];
  }>;
}) {
  const viewer = await verifySession();
  const params = await searchParams;
  const expectedAccountId = firstParam(params.expected_account_id);
  const target = parseReturnTarget(expectedAccountPath("/account/password", expectedAccountId));
  if (expectedAccountId !== null && viewer.userId !== expectedAccountId) return <BrowserAccountMismatch target={target} />;
  return (
    <AuthSurface
      title="Set or replace password"
      description="Use this password to sign in with your Nexus account email."
    >
      <PasswordUpdateForm
        nextPath={parseReturnTarget(firstParam(params.next))}
        saved={firstParam(params.saved) === "1"}
        expectedAccountId={expectedAccountId}
      />
    </AuthSurface>
  );
}
