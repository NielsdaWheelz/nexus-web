"use client";

import { useEffect } from "react";

import { useViewportState } from "@/lib/renderEnvironment/provider";
import { activityRecorder } from "./activityRecorder";
import { activityUploader } from "./activityUploader";

/** Capture runs once the viewport is hydrated; the recorder decides what a hidden tab still
 * counts. Leaving the page closes every span and hands them to the browser. */
export default function ActivityCaptureLifecycle(): null {
  const hydrated = useViewportState().hydrated;

  useEffect(() => {
    const recorder = activityRecorder();
    const uploader = activityUploader();
    recorder.setCaptureReady(hydrated);
    if (!hydrated) return;
    const refresh = () => recorder.refresh();
    const leave = () => {
      recorder.closeForLifecycle();
      uploader.flush({ keepalive: true });
    };
    const resume = () => recorder.setCaptureReady(true);
    const online = () => uploader.flush();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", online);
      recorder.closeForLifecycle();
    };
  }, [hydrated]);

  return null;
}
