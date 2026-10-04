"use client";

import { useEffect, useState } from "react";

import { useViewportState } from "@/lib/renderEnvironment/provider";
import { activityRecorder } from "./activityRecorder";
import { activityRuntime, useActivityRuntimeSnapshot } from "./activityRuntime";

/** Capture runs once the account's outbox is open, the viewport hydrated, the tab visible and
 * capture unblocked. */
const ready = (opened: boolean, hydrated: boolean, capture: string) =>
  opened &&
  hydrated &&
  document.visibilityState === "visible" &&
  (capture === "Idle" || capture === "Recording");

export default function ActivityCaptureLifecycle({ accountId }: { readonly accountId: string }) {
  const hydrated = useViewportState().hydrated;
  const capture = useActivityRuntimeSnapshot().capture.kind;
  const [openedAccount, setOpenedAccount] = useState<string>();
  const opened = openedAccount === accountId;

  useEffect(() => {
    let mounted = true;
    activityRecorder().setCaptureReady(false);
    void activityRuntime()
      .open(accountId)
      .then(() => mounted && setOpenedAccount(accountId));
    return () => {
      mounted = false;
      activityRecorder().closeForLifecycle();
    };
  }, [accountId]);

  useEffect(() => {
    activityRecorder().setCaptureReady(ready(opened, hydrated, capture));
  }, [opened, hydrated, capture]);

  useEffect(() => {
    const drain = () => void activityRuntime().drain();
    const resume = () => {
      drain();
      const capture = activityRuntime().snapshot().capture.kind;
      activityRecorder().setCaptureReady(ready(opened, hydrated, capture));
    };
    const close = () => activityRecorder().closeForLifecycle();
    const onVisibility = () => (document.visibilityState === "hidden" ? close() : resume());
    const events = [
      ["pagehide", close],
      ["focus", resume],
      ["pageshow", resume],
      ["online", drain],
    ] as const;
    document.addEventListener("visibilitychange", onVisibility);
    for (const [event, listener] of events) window.addEventListener(event, listener);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      for (const [event, listener] of events) window.removeEventListener(event, listener);
    };
  }, [opened, hydrated]);

  return null;
}
