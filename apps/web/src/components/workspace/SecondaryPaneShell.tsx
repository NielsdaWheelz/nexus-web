"use client";

import { useId, useRef } from "react";
import type { ComponentType } from "react";
import {
  BarChart3,
  FileText,
  GitBranch,
  Highlighter,
  Link2,
  MessageSquare,
  X,
} from "lucide-react";
import Button from "@/components/ui/Button";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import type { PaneSecondaryPublication } from "@/components/workspace/PaneSecondary";
import { getSecondarySurfaceDefinition } from "@/lib/panes/paneSecondaryModel";
import type {
  PaneSecondaryIconId,
  WorkspaceSecondarySizing,
  WorkspaceSecondaryState,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import styles from "./SecondaryPaneShell.module.css";

const SECONDARY_ICONS: Record<
  PaneSecondaryIconId,
  ComponentType<{ size?: number; "aria-hidden"?: "true" }>
> = {
  "bar-chart-3": BarChart3,
  "file-text": FileText,
  "git-branch": GitBranch,
  highlighter: Highlighter,
  "link-2": Link2,
  "message-square": MessageSquare,
};

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
  const panelId = useId();
  const tabRefs = useRef(new Map<WorkspaceSecondarySurfaceId, HTMLButtonElement>());
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
  const tabId = (surfaceId: WorkspaceSecondarySurfaceId) =>
    `${panelId}-${surfaceId}-tab`;
  const surfacePanelId = (surfaceId: WorkspaceSecondarySurfaceId) =>
    `${panelId}-${surfaceId}-panel`;

  const selectSurface = (surfaceId: WorkspaceSecondarySurfaceId) => {
    onActiveSurfaceChange(secondaryPaneId, surfaceId);
    window.requestAnimationFrame(() => tabRefs.current.get(surfaceId)?.focus());
  };

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
        <div className={styles.tabs} role="tablist" aria-label="Secondary surfaces">
          {publication.surfaces.map((surface, index) => {
            const surfaceDefinition = getSecondarySurfaceDefinition(surface.id);
            const Icon = SECONDARY_ICONS[surfaceDefinition.iconId];
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
                id={tabId(surface.id)}
                type="button"
                role="tab"
                aria-controls={surfacePanelId(surface.id)}
                aria-selected={active}
                aria-label={surfaceDefinition.title}
                title={surfaceDefinition.title}
                tabIndex={active ? 0 : -1}
                className={styles.tab}
                data-active={active ? "true" : "false"}
                onClick={() => onActiveSurfaceChange(secondaryPaneId, surface.id)}
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
          onClick={() => onClose(secondaryPaneId)}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </header>
      <div
        id={surfacePanelId(activeSurface.id)}
        role="tabpanel"
        aria-labelledby={tabId(activeSurface.id)}
        className={styles.body}
      >
        {activeSurface.body}
      </div>
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-label={`Resize ${activeSurfaceDefinition.title}`}
        aria-controls={surfacePanelId(activeSurface.id)}
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
