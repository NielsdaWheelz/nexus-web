"use client";

import { useEffect } from "react";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import { activityRecorder } from "./activityRecorder";

/** Shell-owned bridge from hydrated browser lifecycle facts to the recorder. */
export default function ActivityCaptureLifecycle() {
  const viewport = useViewportState();

  useEffect(() => {
    activityRecorder().setCaptureReady(viewport.hydrated);
  }, [viewport.hydrated]);

  useEffect(() => {
    const flush = () => activityRecorder().flushForPageHide();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  return null;
}
