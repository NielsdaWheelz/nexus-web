"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { installedApp } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { nativeIsForeground, subscribeNativeForeground } from "@/lib/native/foreground";

/** Presentation admits observation; hiding never changes connectivity or domain state. */
export function useObservationDemand(presented: boolean): boolean {
  const [shown, setShown] = useState(false);
  const native = useSyncExternalStore(subscribeNativeForeground, nativeIsForeground, () => false);
  const admission = useRemoteAdmission();
  useEffect(() => {
    const visible = () => setShown(document.visibilityState === "visible");
    const hidden = () => setShown(false);
    visible();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", visible);
    window.addEventListener("pagehide", hidden);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", visible);
      window.removeEventListener("pagehide", hidden);
    };
  }, []);
  return presented && shown && (!installedApp || native && admission === "Ready");
}
