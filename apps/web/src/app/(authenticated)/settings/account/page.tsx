import type { Metadata } from "next";
import { verifySession } from "@/lib/auth/dal";
import SettingsAccountPaneBody from "./SettingsAccountPaneBody";

export const metadata: Metadata = {
  title: "Account · Settings | Nexus",
};

export default async function SettingsAccountPage() {
  const viewer = await verifySession();
  return <SettingsAccountPaneBody initialEmail={viewer.email ?? ""} />;
}
