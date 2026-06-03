"use client";

import { X } from "lucide-react";
import { useId, useRef } from "react";
import Button from "@/components/ui/Button";
import SecondarySurfaceTabs, {
  secondarySurfacePanelId,
  secondarySurfaceTabId,
} from "@/components/workspace/SecondarySurfaceTabs";
import type { PaneSecondaryPublication } from "@/components/workspace/PaneSecondary";
import {
  getSecondarySurfaceDefinition,
  type WorkspaceSecondaryState,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import styles from "./MobileSecondaryPaneHost.module.css";

interface MobileSecondaryPaneHostProps {
  secondaryPaneId: string;
  secondary: WorkspaceSecondaryState | null;
  publication: PaneSecondaryPublication | null;
  onClose: (secondaryPaneId: string) => void;
  onActiveSurfaceChange: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
}

export default function MobileSecondaryPaneHost({
  secondaryPaneId,
  secondary,
  publication,
  onClose,
  onActiveSurfaceChange,
}: MobileSecondaryPaneHostProps) {
  const baseId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const activeSurface =
    publication?.surfaces.find((surface) => surface.id === secondary?.activeSurfaceId) ??
    null;
  const activeSurfaceId = activeSurface?.id ?? null;
  const active = Boolean(
    secondary?.visibility === "visible" &&
      publication &&
      secondary.groupId === publication.groupId &&
      activeSurface,
  );

  useDialogOverlay({
    ref: sheetRef,
    active,
    onDismiss: () => onClose(secondaryPaneId),
    initialFocus: (c) => c.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
    returnFocusFallback: () =>
      document.querySelector<HTMLElement>('[data-active="true"] [data-pane-chrome-focus="true"]'),
    focusKey: activeSurfaceId,
  });

  if (!active || !publication || !secondary || !activeSurface) {
    return null;
  }

  const activeSurfaceDefinition = getSecondarySurfaceDefinition(activeSurface.id);

  return (
    <div
      className={styles.backdrop}
      data-testid="mobile-secondary-backdrop"
      onClick={() => onClose(secondaryPaneId)}
    >
      <aside
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={activeSurfaceDefinition.title}
        data-testid="mobile-secondary-host"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <SecondarySurfaceTabs
            baseId={baseId}
            surfaces={publication.surfaces}
            activeSurfaceId={activeSurface.id}
            onSelect={(surfaceId) => onActiveSurfaceChange(secondaryPaneId, surfaceId)}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Close ${activeSurfaceDefinition.title}`}
            onClick={() => onClose(secondaryPaneId)}
          >
            <X size={15} aria-hidden="true" />
          </Button>
        </header>
        <div
          id={secondarySurfacePanelId(baseId, activeSurface.id)}
          role="tabpanel"
          aria-labelledby={secondarySurfaceTabId(baseId, activeSurface.id)}
          className={styles.body}
        >
          {activeSurface.mobileBody ?? activeSurface.body}
        </div>
      </aside>
    </div>
  );
}
