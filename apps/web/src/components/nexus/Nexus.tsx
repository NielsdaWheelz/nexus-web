"use client";

// The Nexus mount: one controller, the desktop palette or the mobile switchboard.
import { useRef } from "react";
import MobileQuickNoteHandoff from "@/components/switchboard/MobileQuickNoteHandoff";
import NexusButton from "@/components/switchboard/NexusButton";
import SwitchboardTask from "@/components/switchboard/SwitchboardTask";
import DesktopNexus from "./desktop/DesktopNexus";
import { useNexusController } from "./useNexusController";

export default function Nexus() {
  const controller = useNexusController();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // An open before hydration (the URL ingress) waits until the viewport kind is known.
  if (controller.open && !controller.hydrated) return null;
  if (!controller.isMobile) return <DesktopNexus controller={controller} />;
  return (
    <>
      <SwitchboardTask controller={controller} returnFocusTo={() => buttonRef.current} />
      <MobileQuickNoteHandoff ref={controller.handoff} />
      <NexusButton
        buttonRef={buttonRef}
        paneCount={controller.panes.length}
        open={controller.open}
        onOpen={controller.openRoot}
        onSwipe={controller.activateAdjacentPane}
      />
    </>
  );
}
