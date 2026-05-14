import { headers } from "next/headers";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import SettingsLocalVaultPaneBody from "./SettingsLocalVaultPaneBody";

export default async function SettingsLocalVaultPage() {
  const headerStore = await headers();
  return (
    <SettingsLocalVaultPaneBody
      initialAndroidShell={isAndroidShellUserAgent(
        headerStore.get("user-agent") ?? ""
      )}
    />
  );
}
