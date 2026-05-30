"use client";

import { useId, useRef } from "react";
import type { ComponentType } from "react";
import {
  BarChart3,
  FileText,
  GitBranch,
  Highlighter,
  Link2,
  ListTree,
  MessageSquare,
  X,
} from "lucide-react";
import Button from "@/components/ui/Button";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import type { PaneSidecarPublication } from "@/components/workspace/PaneSidecar";
import { getSidecarSurfaceDefinition } from "@/lib/panes/paneSidecarModel";
import type {
  PaneSidecarIconId,
  WorkspaceSidecarSizing,
  WorkspaceSidecarState,
  WorkspaceSidecarSurfaceId,
} from "@/lib/panes/paneSidecarModel";
import styles from "./SidecarPaneShell.module.css";

const SIDE_CAR_ICONS: Record<
  PaneSidecarIconId,
  ComponentType<{ size?: number; "aria-hidden"?: "true" }>
> = {
  "bar-chart-3": BarChart3,
  "file-text": FileText,
  "git-branch": GitBranch,
  highlighter: Highlighter,
  "link-2": Link2,
  "list-tree": ListTree,
  "message-square": MessageSquare,
};

interface SidecarPaneShellProps {
  paneId: string;
  publication: PaneSidecarPublication;
  state: WorkspaceSidecarState;
  sizing: WorkspaceSidecarSizing;
  onActiveSurfaceChange: (
    paneId: string,
    surfaceId: WorkspaceSidecarSurfaceId,
  ) => void;
  onClose: (paneId: string) => void;
  onResize: (paneId: string, widthPx: number) => void;
}

export default function SidecarPaneShell({
  paneId,
  publication,
  state,
  sizing,
  onActiveSurfaceChange,
  onClose,
  onResize,
}: SidecarPaneShellProps) {
  const panelId = useId();
  const tabRefs = useRef(new Map<WorkspaceSidecarSurfaceId, HTMLButtonElement>());
  const activeSurface =
    publication.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
  const { handleResizeMouseDown, handleResizeKeyDown } = useResizeHandle({
    id: paneId,
    widthPx: sizing.widthPx,
    minWidthPx: sizing.minWidthPx,
    maxWidthPx: sizing.maxWidthPx,
    onResize,
  });

  if (!activeSurface) {
    return null;
  }

  const activeSurfaceDefinition = getSidecarSurfaceDefinition(activeSurface.id);

  const selectSurface = (surfaceId: WorkspaceSidecarSurfaceId) => {
    onActiveSurfaceChange(paneId, surfaceId);
    window.requestAnimationFrame(() => tabRefs.current.get(surfaceId)?.focus());
  };

  return (
    <aside
      className={styles.sidecar}
      style={{
        width: sizing.widthPx,
        minWidth: sizing.minWidthPx,
        maxWidth: sizing.maxWidthPx,
      }}
      aria-label={activeSurfaceDefinition.title}
      data-testid="workspace-sidecar-pane"
    >
      <header className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Sidecar surfaces">
          {publication.surfaces.map((surface, index) => {
            const surfaceDefinition = getSidecarSurfaceDefinition(surface.id);
            const Icon = SIDE_CAR_ICONS[surfaceDefinition.iconId];
            const active = surface.id === activeSurface.id;
            return (
              <button
                key={surface.id}
                ref={(element) => {
                  if (element) {
                    tabRefs.current.set(surface.id, element);
                  } else {
                    tabRefs.current.delete(surface.id);
                  }
                }}
                id={`${panelId}-${surface.id}-tab`}
                type="button"
                role="tab"
                aria-controls={panelId}
                aria-selected={active}
                aria-label={surfaceDefinition.title}
                title={surfaceDefinition.title}
                tabIndex={active ? 0 : -1}
                className={styles.tab}
                data-active={active ? "true" : "false"}
                onClick={() => onActiveSurfaceChange(paneId, surface.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    const direction = event.key === "ArrowRight" ? 1 : -1;
                    const nextIndex =
                      (index + direction + publication.surfaces.length) %
                      publication.surfaces.length;
                    const nextSurface = publication.surfaces[nextIndex];
                    if (nextSurface) {
                      selectSurface(nextSurface.id);
                    }
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    const firstSurface = publication.surfaces[0];
                    if (firstSurface) {
                      selectSurface(firstSurface.id);
                    }
                  } else if (event.key === "End") {
                    event.preventDefault();
                    const lastSurface =
                      publication.surfaces[publication.surfaces.length - 1];
                    if (lastSurface) {
                      selectSurface(lastSurface.id);
                    }
                  }
                }}
              >
                <Icon size={18} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Close ${activeSurfaceDefinition.title}`}
          onClick={() => onClose(paneId)}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </header>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-${activeSurface.id}-tab`}
        className={styles.body}
      >
        {activeSurface.body}
      </div>
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-label={`Resize ${activeSurfaceDefinition.title}`}
        aria-controls={panelId}
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
