import { PASSIVE_OBSERVATION_MS } from "@/lib/api/observationPolicy";
import { installedApp, remoteAdmission, subscribeAdmission } from "@/lib/native/admission";
import { nativeIsForeground, subscribeNativeForeground } from "@/lib/native/foreground";
import type { SyncStep } from "./sync";

/** Foreground replication polls because a waiting serverless request reserves memory.
 * Only this document schedules successors; the durable worker performs finite units. */
export function scheduleReplication(step: (refresh: boolean) => Promise<SyncStep>, failed: (error: unknown) => void): { wake(): void; close(): void } {
  let closed = false, running = false, refresh = true, pageHidden = false;
  let nextRefresh = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const active = () => !closed && !pageHidden && document.visibilityState === "visible" && (!installedApp || nativeIsForeground());
  const admitted = () => remoteAdmission() === "Ready" || remoteAdmission() === "Unavailable";
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const run = async () => {
    clear();
    if (running || !active() || !admitted()) return;
    running = true;
    const fresh = refresh || Date.now() >= nextRefresh;
    refresh = false;
    if (fresh) nextRefresh = Date.now() + PASSIVE_OBSERVATION_MS;
    try {
      const result = await step(fresh);
      if (!active() || !admitted()) return;
      const passive = Math.max(1, nextRefresh - Date.now());
      const delay = result.more || refresh ? 0 : result.retry_after_ms === null ? passive : Math.min(passive, result.retry_after_ms);
      timer = setTimeout(() => { timer = null; void run(); }, delay);
    } catch (error) { failed(error); }
    finally { running = false; }
  };
  const wake = () => { refresh = true; void run(); };
  const visibility = () => { if (active()) wake(); else clear(); };
  const hide = () => { pageHidden = true; clear(); };
  const show = () => { pageHidden = false; visibility(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
  window.addEventListener("online", wake); window.addEventListener("offline", wake); window.addEventListener("focus", visibility);
  const unsubscribeAdmission = subscribeAdmission(visibility);
  const unsubscribeForeground = subscribeNativeForeground(visibility);
  queueMicrotask(() => { void run(); });
  return { wake, close() {
    closed = true; clear(); unsubscribeAdmission(); unsubscribeForeground();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show);
    window.removeEventListener("online", wake); window.removeEventListener("offline", wake); window.removeEventListener("focus", visibility);
  } };
}
