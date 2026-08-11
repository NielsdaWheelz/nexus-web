"use client";

import { useEffect, useState } from "react";

import { useViewportState } from "@/lib/renderEnvironment/provider";
import { activityRecorder } from "./activityRecorder";
import {
  activityRuntime,
  useActivityRuntimeSnapshot,
} from "./activityRuntime";

function captureAllowed(kind: string): boolean {
  return kind === "Idle" || kind === "Recording";
}

/** Auth-shell composition for durable capture and browser recovery triggers. */
export default function ActivityCaptureLifecycle({
  accountId,
}: {
  readonly accountId: string;
}) {
  const viewport = useViewportState();
  const snapshot = useActivityRuntimeSnapshot();
  const [openedAccount, setOpenedAccount] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;
    const recorder = activityRecorder();
    recorder.setCaptureReady(false);
    void activityRuntime().open(accountId).then(() => {
      if (mounted) setOpenedAccount(accountId);
    });
    return () => {
      mounted = false;
      recorder.closeForLifecycle("ShellUnmount");
    };
  }, [accountId]);

  useEffect(() => {
    activityRecorder().setCaptureReady(
      openedAccount === accountId &&
        viewport.hydrated &&
        document.visibilityState === "visible" &&
        captureAllowed(snapshot.capture.kind),
    );
  }, [
    accountId,
    openedAccount,
    snapshot.capture.kind,
    viewport.hydrated,
  ]);

  useEffect(() => {
    const resume = (trigger: "Foreground" | "Focus" | "PageShow") => {
      void activityRuntime().drain(trigger);
      activityRecorder().setCaptureReady(
        openedAccount === accountId &&
          viewport.hydrated &&
          document.visibilityState === "visible" &&
          captureAllowed(activityRuntime().snapshot().capture.kind),
      );
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        activityRecorder().closeForLifecycle("Hidden");
      } else {
        resume("Foreground");
      }
    };
    const onPageHide = () =>
      activityRecorder().closeForLifecycle("PageHide");
    const onFocus = () => resume("Focus");
    const onPageShow = () => resume("PageShow");
    const onOnline = () => void activityRuntime().drain("Online");
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, [accountId, openedAccount, viewport.hydrated]);

  return null;
}
