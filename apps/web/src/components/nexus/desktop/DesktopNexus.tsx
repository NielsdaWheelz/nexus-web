"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  nexusEntryHasSecondaryActions,
  nexusEntryKeyValue,
  type NexusEntry,
} from "@/lib/nexus/model";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import DesktopNexusInput from "./DesktopNexusInput";
import DesktopNexusResults from "./DesktopNexusResults";
import type {
  DesktopNexusActionsOpener,
  DesktopNexusCell,
  DesktopNexusController,
  DesktopNexusModality,
} from "./types";
import styles from "./desktopNexus.module.css";

export default function DesktopNexus({
  controller,
}: {
  controller: DesktopNexusController;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionsOpenersRef = useRef(new Map<string, DesktopNexusActionsOpener>());
  const openMenuKeyRef = useRef<string | null>(null);
  const handledActionsRequestRef = useRef<number | null>(null);
  const [activeCell, setActiveCell] = useState<DesktopNexusCell>("Primary");
  const overlay = useDialogOverlay({
    ref: panelRef,
    active: controller.open,
    onDismiss: controller.escape,
    initialFocus: (container) => {
      if (controller.workflow) {
        return container.querySelector<HTMLElement>(
          "[data-nexus-workflow-initial-focus]",
        );
      }
      return container.querySelector<HTMLElement>('input[role="combobox"]');
    },
    skipReturnFocus: controller.shouldSuppressReturnFocusOnClose,
    focusKey: controller.focusKey,
    layerScope: "nexus",
  });

  const registerActionsOpener = useCallback(
    (key: string, opener: DesktopNexusActionsOpener | null) => {
      if (opener) actionsOpenersRef.current.set(key, opener);
      else actionsOpenersRef.current.delete(key);
    },
    [],
  );
  const openActions = useCallback(
    (entry: NexusEntry, modality: DesktopNexusModality) => {
      const opener = actionsOpenersRef.current.get(
        nexusEntryKeyValue(entry.key),
      );
      if (!opener) return;
      controller.setActiveEntry(entry.key);
      setActiveCell("Actions");
      opener(entry, modality);
    },
    [controller],
  );
  const onActionMenuOpenChange = useCallback(
    (key: string, open: boolean) => {
      if (open) {
        openMenuKeyRef.current = key;
        setActiveCell("Actions");
        return;
      }
      if (openMenuKeyRef.current !== key) return;
      openMenuKeyRef.current = null;
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [],
  );

  useEffect(() => {
    if (!controller.open) {
      openMenuKeyRef.current = null;
      setActiveCell("Primary");
    }
  }, [controller.open]);

  useEffect(() => {
    if (activeCell !== "Actions") return;
    const activeKey = controller.projection.activeKey
      ? nexusEntryKeyValue(controller.projection.activeKey)
      : null;
    const activeEntry = controller.projection.groups
      .flatMap((group) => group.entries)
      .find((entry) => nexusEntryKeyValue(entry.key) === activeKey);
    if (!activeEntry || !nexusEntryHasSecondaryActions(activeEntry)) {
      setActiveCell("Primary");
    }
  }, [activeCell, controller.projection]);

  useEffect(() => {
    const request = controller.actionsRequest;
    if (
      !controller.open ||
      controller.workflow ||
      !request ||
      handledActionsRequestRef.current === request.requestId
    ) {
      return;
    }
    const opener = actionsOpenersRef.current.get(
      nexusEntryKeyValue(request.entry.key),
    );
    if (!opener) return;
    handledActionsRequestRef.current = request.requestId;
    openActions(request.entry, "Keyboard");
  }, [controller.actionsRequest, controller.open, controller.workflow, openActions]);

  if (controller.projection.surface !== "Desktop") {
    throw new Error("DesktopNexus requires a Desktop projection");
  }
  if (!controller.open) return null;

  return createPortal(
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.backdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={controller.escape}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Nexus"
          className={styles.surface}
          onClick={(event) => event.stopPropagation()}
        >
          {controller.workflow ? (
            controller.workflow
          ) : (
            <>
              <h2 className="sr-only">Nexus</h2>
              <DesktopNexusInput
                controller={controller}
                inputRef={inputRef}
                activeCell={activeCell}
                setActiveCell={setActiveCell}
                openActions={openActions}
              />
              <DesktopNexusResults
                controller={controller}
                activeCell={activeCell}
                setActiveCell={setActiveCell}
                registerActionsOpener={registerActionsOpener}
                onActionMenuOpenChange={onActionMenuOpenChange}
              />
            </>
          )}
        </div>
      </div>
    </ModalLayerProvider>,
    document.body,
  );
}
