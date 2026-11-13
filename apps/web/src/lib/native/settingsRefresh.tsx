"use client";
/** server acceptance and durable device settings are separate acknowledgements.
 * the browser lock orders refresh reads and copies across tabs sharing a binding.
 * retry refreshes the local copy and never resends an accepted edit. */
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { saveBrowserSettings } from "@/lib/authored/binding";
import { installedApp, remoteAdmission } from "./admission";
import { refreshDeviceSettings } from "./client";

const Context = createContext<{ refresh(): Promise<void> } | null>(null);

export function DeviceSettingsProvider({ children, browserLifetime }: { children: ReactNode; browserLifetime: string | null }) {
  const { say } = useOutcome();
  const refresh = useCallback(async function refresh(): Promise<void> {
    try {
      if (browserLifetime === null) {
        await refreshDeviceSettings();
        if (remoteAdmission() !== "Ready") throw new Error("settings refresh unavailable");
        window.dispatchEvent(new Event("nexus:device-settings-refreshed"));
      } else {
        await navigator.locks.request("nexus-browser-settings-refresh", async () => {
          const [me, reader] = await Promise.all([
            apiFetch<ApiJson<"/me", "get">>("/api/me"),
            apiFetch<ApiJson<"/me/reader-profile", "get">>("/api/me/reader-profile"),
          ]);
          await saveBrowserSettings({
            account: { account_id: me.data.user_id, calendar_time_zone: me.data.calendar_time_zone },
            reader_profile: reader.data,
          }, browserLifetime);
        });
      }
    } catch {
      say({ fact: "couldn’t update settings on this device.", reason: "nexus may reopen with earlier settings." },
        [{ label: "retry", commandKey: "RetryDeviceSettings", run: () => void refresh() }]);
    }
  }, [browserLifetime, say]);
  // justify-defect: only the browser shell carries an admitted browser binding lifetime.
  if (installedApp !== (browserLifetime === null)) throw new Error("settings refresh binding does not match its host");
  return <Context value={{ refresh }}>{children}</Context>;
}

export function useSettingsRefresh(): () => Promise<void> {
  const state = useContext(Context);
  if (!state) throw new Error("useSettingsRefresh requires DeviceSettingsProvider");
  return state.refresh;
}
