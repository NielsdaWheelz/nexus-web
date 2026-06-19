"use client";

import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useLauncherController } from "./useLauncherController";
import LauncherSheet from "./LauncherSheet";
import LauncherSurface from "./LauncherSurface";

export default function Launcher() {
  const controller = useLauncherController();
  const isMobile = useIsMobileViewport();
  return (
    <>
      {/* Stays mounted, gated by `active` (MobileSheet mount contract): its history wiring
          must observe every close path. */}
      <LauncherSheet controller={controller} active={controller.open && isMobile} />
      {controller.open && !isMobile ? <LauncherSurface controller={controller} /> : null}
    </>
  );
}
