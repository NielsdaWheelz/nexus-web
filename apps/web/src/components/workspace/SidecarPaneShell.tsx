"use client";

import { useId, useRef } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import type { PaneSidecarDescriptor } from "@/components/workspace/PaneSidecar";
import type {
  WorkspaceSidecarSizing,
  WorkspaceSidecarState,
  WorkspaceSidecarSurfaceId,
} from "@/lib/workspace/sidecarSizing";
import styles from "./SidecarPaneShell.module.css";

interface SidecarPaneShellProps {
  paneId: string;
  descriptor: PaneSidecarDescriptor;
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
  descriptor,
  state,
  sizing,
  onActiveSurfaceChange,
  onClose,
  onResize,
}: SidecarPaneShellProps) {
  const panelId = useId();
  const tabRefs = useRef(new Map<WorkspaceSidecarSurfaceId, HTMLButtonElement>());
  const activeSurface =
    descriptor.surfaces.find((surface) => surface.id === state.activeSurfaceId) ??
    descriptor.surfaces.find((surface) => surface.id === descriptor.defaultSurfaceId) ??
    descriptor.surfaces[0] ??
    null;
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
      aria-label={activeSurface.title}
      data-testid="workspace-sidecar-pane"
    >
      <header className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Sidecar surfaces">
          {descriptor.surfaces.map((surface, index) => {
            const Icon = surface.icon;
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
                aria-label={surface.title}
                title={surface.title}
                tabIndex={active ? 0 : -1}
                className={styles.tab}
                data-active={active ? "true" : "false"}
                onClick={() => onActiveSurfaceChange(paneId, surface.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    const direction = event.key === "ArrowRight" ? 1 : -1;
                    const nextIndex =
                      (index + direction + descriptor.surfaces.length) %
                      descriptor.surfaces.length;
                    const nextSurface = descriptor.surfaces[nextIndex];
                    if (nextSurface) {
                      selectSurface(nextSurface.id);
                    }
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    const firstSurface = descriptor.surfaces[0];
                    if (firstSurface) {
                      selectSurface(firstSurface.id);
                    }
                  } else if (event.key === "End") {
                    event.preventDefault();
                    const lastSurface =
                      descriptor.surfaces[descriptor.surfaces.length - 1];
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
          aria-label={`Close ${activeSurface.title}`}
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
        aria-label={`Resize ${activeSurface.title}`}
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
