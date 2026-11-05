"use client";

// The Nexus mount: one controller, the desktop palette or the phone's sheet and disc.
import { useRef } from "react";
import ImportDoors from "@/components/imports/ImportDoors";
import NexusButton from "@/components/switchboard/NexusButton";
import SwitchboardTask from "@/components/switchboard/SwitchboardTask";
import DesktopNexus from "./desktop/DesktopNexus";
import { useNexusController } from "./useNexusController";

export default function Nexus() {
  const controller = useNexusController();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Presentation waits for the viewport; document doors keep their one lifetime.
  return (
    <>
      <ImportDoors admit={controller.admitImport} />
      {controller.open && !controller.hydrated ? null : controller.isMobile ? <>
        <SwitchboardTask controller={controller} />
        <NexusButton
          buttonRef={buttonRef}
          paneCount={controller.panes.length}
          open={controller.open}
          onOpen={() => {
            buttonRef.current?.focus({ preventScroll: true });
            controller.openRoot();
          }}
          onSwipe={input => {
            const result = controller.activateAdjacentPane(input);
            if (result.kind === "Unchanged") return input.direction === "Next" ? "last pane" : "first pane";
            const title = controller.panes.find(pane => pane.id === result.paneId)?.presentation.title;
            return title ? title : null;
          }}
        />
      </> : <DesktopNexus controller={controller} />}
    </>
  );
}
