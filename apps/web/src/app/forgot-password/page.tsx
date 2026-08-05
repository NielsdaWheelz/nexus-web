import type { Metadata } from "next";
import AuthSurface from "@/components/auth/AuthSurface";
import { getFirstSearchParamValue } from "@/lib/auth/redirects";
import ForgotPasswordForm from "./ForgotPasswordForm";

export const metadata: Metadata = {
  title: "Reset your password · Nexus",
  robots: { index: false, follow: false },
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string | string[] }>;
}) {
  const sent = getFirstSearchParamValue((await searchParams).sent) === "1";
  return (
    <AuthSurface
      title="Reset your password"
      description={
        sent
          ? undefined
          : "Enter the email address for your Nexus account. We’ll send you a link to choose a new password."
      }
    >
      <ForgotPasswordForm sent={sent} />
    </AuthSurface>
  );
}
