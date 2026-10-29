"use client";
/** Server settings success and native durability are separate acknowledgements.
 * A failed local refresh stays in the settings pane; retry never resends edits. */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { FeedbackFailure, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import { installedApp, remoteAdmission } from "./admission";
import { refreshDeviceSettings } from "./client";
const Context = createContext<{ refresh(): Promise<void>; failed: boolean; busy: boolean; occurrence: object } | null>(null);
export function DeviceSettingsProvider({ children }: { children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const occurrence = useFeedbackOccurrence(failed);
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
  return <Context value={{ refresh, failed, busy, occurrence }}>{children}</Context>;
}
export function DeviceSettingsStatus() {
  const state = useContext(Context);
  if (!state?.failed) return null;
  return <FeedbackFailure scope="Local" occurrence={state.occurrence} announcement="Polite" content={{ tone: "Warning", title: "couldn’t refresh settings on this device", message: "reopening offline may use earlier settings." }} actions={[{ label: "retry", busy: state.busy, onClick: () => void state.refresh() }]} />;
}
export function useSettingsRefresh(): () => Promise<void> {
  const state = useContext(Context);
  if (!state) throw new Error("useSettingsRefresh requires DeviceSettingsProvider");
  return state.refresh;
}
