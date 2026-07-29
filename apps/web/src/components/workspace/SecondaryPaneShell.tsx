"use client";

import { useId } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import SecondarySurfaceTabs, {
  secondarySurfacePanelId,
} from "@/components/workspace/SecondarySurfaceTabs";
import SecondarySurfacePanels from "@/components/workspace/SecondarySurfacePanels";
import {
  getPublishedSecondarySurface,
  type PaneSecondaryPublication,
  type PaneSecondaryPresentationSurfacePublication,
  type PaneTransientSecondarySurfacePublication,
} from "@/lib/panes/panePublications";
import {
  getPaneSecondarySurfaceDefinition,
  isPaneTransientSecondarySurfaceId,
  paneSecondaryRegionId,
} from "@/lib/panes/paneSecondaryModel";
import type {
  WorkspaceSecondarySizing,
  WorkspaceSecondaryState,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import styles from "./SecondaryPaneShell.module.css";

interface SecondaryPaneShellProps {
  primaryPaneId: string;
  secondaryPaneId: string;
  publication: PaneSecondaryPublication;
  state: WorkspaceSecondaryState | null;
  transientSurface?: PaneTransientSecondarySurfacePublication | null;
  sizing: WorkspaceSecondarySizing;
  onActiveSurfaceChange: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onSelectDurableFromTransient?: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onClose: (secondaryPaneId: string) => void;
  onCloseTransient?: () => void;
  onResize: (secondaryPaneId: string, widthPx: number) => void;
}

export default function SecondaryPaneShell({
  primaryPaneId,
  secondaryPaneId,
  publication,
  state,
  transientSurface = null,
  sizing,
  onActiveSurfaceChange,
  onSelectDurableFromTransient,
  onClose,
  onCloseTransient,
  onResize,
}: SecondaryPaneShellProps) {
  const baseId = useId();
  const activeSurface =
    transientSurface ??
    getPublishedSecondarySurface(publication, state?.activeSurfaceId);
  const surfaces: readonly PaneSecondaryPresentationSurfacePublication[] =
    transientSurface
      ? [...publication.surfaces, transientSurface]
      : publication.surfaces;
  const showTabs = publication.surfaces.length > 0;
  const { handleResizeMouseDown, handleResizeKeyDown } = useResizeHandle({
    id: secondaryPaneId,
    widthPx: sizing.widthPx,
    minWidthPx: sizing.minWidthPx,
    maxWidthPx: sizing.maxWidthPx,
    onResize,
  });

  if (!activeSurface) {
    return null;
  }
  if (
    transientSurface &&
    (!onCloseTransient || !onSelectDurableFromTransient)
  ) {
    throw new Error(
      "Transient secondary presentation requires close and durable-select commands.",
    );
  }

  const activeSurfaceDefinition = getPaneSecondarySurfaceDefinition(
    activeSurface.id,
  );
  let close = () => onClose(secondaryPaneId);
  let selectDurableFromTransient:
    | ((
        secondaryPaneId: string,
        surfaceId: WorkspaceSecondarySurfaceId,
      ) => void)
    | null = null;
  if (transientSurface && onCloseTransient && onSelectDurableFromTransient) {
    close = onCloseTransient;
    selectDurableFromTransient = onSelectDurableFromTransient;
  }

  return (
    <aside
      id={paneSecondaryRegionId(primaryPaneId, publication.groupId)}
      className={styles.secondary}
      style={{
        width: sizing.widthPx,
        minWidth: sizing.minWidthPx,
        maxWidth: sizing.maxWidthPx,
      }}
      aria-label={activeSurfaceDefinition.title}
      data-testid="workspace-secondary-pane"
      onKeyDown={(event) => {
        // Escape closes the Inspector only while focus is inside it: a keydown
        // reaches this <aside> only by bubbling from a focused descendant.
        // Defer to inner controls that already consumed the key (preventDefault).
        if (event.key !== "Escape" || event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header className={styles.header}>
        {showTabs ? (
          <SecondarySurfaceTabs
            baseId={baseId}
            surfaces={surfaces}
            activeSurfaceId={activeSurface.id}
            onSelect={(surfaceId) => {
              if (!isPaneTransientSecondarySurfaceId(surfaceId)) {
                if (selectDurableFromTransient) {
                  selectDurableFromTransient(secondaryPaneId, surfaceId);
                } else {
                  onActiveSurfaceChange(secondaryPaneId, surfaceId);
                }
              }
            }}
          />
        ) : (
          <span className={styles.soloTitle}>{activeSurfaceDefinition.title}</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Close ${activeSurfaceDefinition.title}`}
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </header>
      {showTabs ? (
        <SecondarySurfacePanels
          baseId={baseId}
          surfaces={surfaces}
          activeSurfaceId={activeSurface.id}
          className={styles.body}
        />
      ) : (
        <div
          id={secondarySurfacePanelId(baseId, activeSurface.id)}
          className={styles.body}
        >
          {activeSurface.body}
        </div>
      )}
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-label={`Resize ${activeSurfaceDefinition.title}`}
        aria-controls={secondarySurfacePanelId(baseId, activeSurface.id)}
        aria-orientation="vertical"
        aria-valuemin={sizing.minWidthPx}
        aria-valuemax={sizing.maxWidthPx}
        aria-valuenow={sizing.widthPx}
        tabIndex={0}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
      />
    </aside>
  );
}
