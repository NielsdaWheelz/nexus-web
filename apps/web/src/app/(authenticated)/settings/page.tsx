import { headers } from "next/headers";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import SettingsPaneBody from "./SettingsPaneBody";

export default async function SettingsPage() {
  const headerStore = await headers();
  return (
    <SettingsPaneBody
      initialAndroidShell={isAndroidShellUserAgent(
        headerStore.get("user-agent") ?? ""
      )}
    />
  );
}
