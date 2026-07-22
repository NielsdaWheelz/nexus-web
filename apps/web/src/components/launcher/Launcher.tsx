"use client";

import { useCallback, useState } from "react";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import LauncherSheet from "./LauncherSheet";
import LauncherSurface from "./LauncherSurface";
import {
  useLauncherController,
  type LauncherController,
} from "./useLauncherController";

function LauncherSubtree({
  controller,
  isMobile,
  waitingForViewport,
  activeAddDefect,
  onAddDefect,
  onClearAddDefect,
}: {
  controller: LauncherController;
  isMobile: boolean;
  waitingForViewport: boolean;
  activeAddDefect: boolean;
  onAddDefect(error: unknown): void;
  onClearAddDefect(): void;
}) {
  return (
    <>
      {/* Stays mounted, gated by `active` (MobileSheet mount contract): its
          history wiring must observe every close path. */}
      <LauncherSheet
        controller={controller}
        active={controller.open && isMobile}
        activeAddDefect={activeAddDefect}
        onAddDefect={onAddDefect}
        onClearAddDefect={onClearAddDefect}
      />
      {controller.open && !isMobile && !waitingForViewport ? (
        <LauncherSurface
          controller={controller}
          activeAddDefect={activeAddDefect}
          onAddDefect={onAddDefect}
          onClearAddDefect={onClearAddDefect}
        />
      ) : null}
    </>
  );
}

export default function Launcher() {
  const controller = useLauncherController();
  const sessionId = controller.addSession.state.sessionId;
  const [addDefect, setAddDefect] = useState<{
    sessionId: string;
    error: unknown;
  } | null>(null);
  const reportAddDefect = useCallback(
    (error: unknown) => {
      console.error("Add content contract failed:", error);
      setAddDefect({ sessionId, error });
    },
    [sessionId],
  );
  const clearAddDefect = useCallback(() => setAddDefect(null), []);
  const viewport = useViewportState();
  const isMobile = viewport.isMobile;
  const waitingForViewport = controller.open && !viewport.hydrated;
  return (
    <LauncherSubtree
      controller={controller}
      isMobile={isMobile}
      waitingForViewport={waitingForViewport}
      activeAddDefect={addDefect?.sessionId === sessionId}
      onAddDefect={reportAddDefect}
      onClearAddDefect={clearAddDefect}
    />
  );
}
