"use client";

import { useId } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import SecondarySurfaceTabs, {
  secondarySurfacePanelId,
  secondarySurfaceTabId,
} from "@/components/workspace/SecondarySurfaceTabs";
import type { PaneSecondaryPublication } from "@/components/workspace/PaneSecondary";
import { getSecondarySurfaceDefinition } from "@/lib/panes/paneSecondaryModel";
import type {
  WorkspaceSecondarySizing,
  WorkspaceSecondaryState,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import styles from "./SecondaryPaneShell.module.css";

interface SecondaryPaneShellProps {
  secondaryPaneId: string;
  publication: PaneSecondaryPublication;
  state: WorkspaceSecondaryState;
  sizing: WorkspaceSecondarySizing;
  onActiveSurfaceChange: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onClose: (secondaryPaneId: string) => void;
  onResize: (secondaryPaneId: string, widthPx: number) => void;
}

export default function SecondaryPaneShell({
  secondaryPaneId,
  publication,
  state,
  sizing,
  onActiveSurfaceChange,
  onClose,
  onResize,
}: SecondaryPaneShellProps) {
  const baseId = useId();
  const activeSurface =
    publication.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
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

  const activeSurfaceDefinition = getSecondarySurfaceDefinition(activeSurface.id);

  return (
    <aside
      className={styles.secondary}
      style={{
        width: sizing.widthPx,
        minWidth: sizing.minWidthPx,
        maxWidth: sizing.maxWidthPx,
      }}
      aria-label={activeSurfaceDefinition.title}
      data-testid="workspace-secondary-pane"
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
        {activeSurface.body}
      </div>
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
