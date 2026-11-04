"use client";
/** Server settings success and native durability are separate acknowledgements. A failed local
 * refresh says so once, as the outcome of `refresh()`; retry refreshes and never resends edits. */
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import { installedApp, remoteAdmission } from "./admission";
import { refreshDeviceSettings } from "./client";
const Context = createContext<{ refresh(): Promise<void> } | null>(null);
export function DeviceSettingsProvider({ children }: { children: ReactNode }) {
  const { say } = useOutcome();
  const refresh = useCallback(async function refresh(): Promise<void> {
    if (!installedApp) return;
    try {
      await refreshDeviceSettings();
      if (remoteAdmission() !== "Ready") throw new Error("settings refresh unavailable");
      window.dispatchEvent(new Event("nexus:device-settings-refreshed"));
    } catch {
      say({ fact: "couldn’t update settings on this device.", reason: "opened offline, nexus may use the earlier ones." },
        [{ label: "retry", commandKey: "RetryDeviceSettings", run: () => void refresh() }]);
    }
  }, [say]);
  return <Context value={{ refresh }}>{children}</Context>;
}
export function useSettingsRefresh(): () => Promise<void> {
  const state = useContext(Context);
  if (!state) throw new Error("useSettingsRefresh requires DeviceSettingsProvider");
  return state.refresh;
}
