"use client";
// Server success and local durability are separate acknowledgements. A local
// refresh failure offers its own retry and never resends an email or edit.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import { installedApp, remoteAdmission } from "./admission";
import { refreshDeviceSettings } from "./client";
const Context = createContext<(() => Promise<void>) | null>(null);
export function DeviceSettingsProvider({ children }: { children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!installedApp) return;
    setBusy(true);
    try {
      await refreshDeviceSettings();
      if (remoteAdmission() !== "Ready") throw new Error("settings refresh unavailable");
      window.dispatchEvent(new Event("nexus:device-settings-refreshed"));
      setFailed(false);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }, []);
  useWorkspaceCondition("device-settings-save", failed ? {
    priority: "Write", announcement: "Polite",
    content: { tone: "Warning", title: "settings weren’t saved on this device", message: "reopening offline may use earlier settings." },
    actions: [{ label: "retry", busy, onClick: () => void refresh() }],
  } : null);
  return <Context value={refresh}>{children}</Context>;
}

export function useSettingsRefresh(): () => Promise<void> {
  const refresh = useContext(Context);
  if (!refresh) throw new Error("useSettingsRefresh requires DeviceSettingsProvider");
  return refresh;
}
