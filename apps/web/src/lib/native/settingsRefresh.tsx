"use client";
/** Server settings success and native durability are separate acknowledgements.
 * A failed local refresh stays in the settings pane; retry never resends edits. */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { installedApp, remoteAdmission } from "./admission";
import { refreshDeviceSettings } from "./client";
const Context = createContext<{ refresh(): Promise<void>; failed: boolean; busy: boolean } | null>(null);
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
  return <Context value={{ refresh, failed, busy }}>{children}</Context>;
}
export function DeviceSettingsStatus() {
  const state = useContext(Context);
  if (!state?.failed) return null;
  return <FeedbackNotice announcement="Polite" content={{ tone: "Warning", title: "settings weren’t saved on this device", message: "reopening offline may use earlier settings." }} actions={[{ label: "retry", busy: state.busy, onClick: () => void state.refresh() }]} />;
}
export function useSettingsRefresh(): () => Promise<void> {
  const state = useContext(Context);
  if (!state) throw new Error("useSettingsRefresh requires DeviceSettingsProvider");
  return state.refresh;
}
