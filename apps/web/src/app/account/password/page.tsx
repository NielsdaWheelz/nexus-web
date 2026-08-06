import type { Metadata } from "next";
import AuthSurface from "@/components/auth/AuthSurface";
import { verifySession } from "@/lib/auth/dal";
import {
  getFirstSearchParamValue,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
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
  }>;
}) {
  await verifySession();
  const params = await searchParams;
  const nextPath = parseAuthReturnTarget(getFirstSearchParamValue(params.next));
  const saved = getFirstSearchParamValue(params.saved) === "1";

  return (
    <AuthSurface
      title="Set or replace password"
      description="Use this password to sign in with your Nexus account email."
    >
      <PasswordUpdateForm nextPath={nextPath} saved={saved} />
    </AuthSurface>
  );
}
