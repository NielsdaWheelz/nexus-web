"use client";

import { useViewportState } from "@/lib/renderEnvironment/provider";
import { useLauncherController } from "./useLauncherController";
import LauncherSheet from "./LauncherSheet";
import LauncherSurface from "./LauncherSurface";

export default function Launcher() {
  const controller = useLauncherController();
  const viewport = useViewportState();
  const isMobile = viewport.isMobile;
  const waitingForViewport = controller.open && !viewport.hydrated;
  return (
    <>
      {/* Stays mounted, gated by `active` (MobileSheet mount contract): its history wiring
          must observe every close path. */}
      <LauncherSheet controller={controller} active={controller.open && isMobile} />
      {controller.open && !isMobile && !waitingForViewport ? (
        <LauncherSurface controller={controller} />
      ) : null}
    </>
  );
}
