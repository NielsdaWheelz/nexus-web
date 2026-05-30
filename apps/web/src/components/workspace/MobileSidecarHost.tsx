"use client";

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
import type { ComponentType } from "react";
import Button from "@/components/ui/Button";
import type { PaneSidecarPublication } from "@/components/workspace/PaneSidecar";
import {
  getSidecarSurfaceDefinition,
  type PaneSidecarIconId,
  type WorkspaceSidecarState,
  type WorkspaceSidecarSurfaceId,
} from "@/lib/panes/paneSidecarModel";
import styles from "./MobileSidecarHost.module.css";

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

interface MobileSidecarHostProps {
  paneId: string;
  sidecar: WorkspaceSidecarState | null;
  publication: PaneSidecarPublication | null;
  onClose: (paneId: string) => void;
  onActiveSurfaceChange: (
    paneId: string,
    surfaceId: WorkspaceSidecarSurfaceId,
  ) => void;
}

export default function MobileSidecarHost({
  paneId,
  sidecar,
  publication,
  onClose,
  onActiveSurfaceChange,
}: MobileSidecarHostProps) {
  if (
    sidecar?.visibility !== "visible" ||
    !publication ||
    sidecar.groupId !== publication.groupId
  ) {
    return null;
  }

  const activeSurface =
    publication.surfaces.find((surface) => surface.id === sidecar.activeSurfaceId) ??
    null;
  if (!activeSurface) {
    return null;
  }

  const activeSurfaceDefinition = getSidecarSurfaceDefinition(activeSurface.id);

  return (
    <div
      className={styles.backdrop}
      data-testid="mobile-sidecar-backdrop"
      onClick={() => onClose(paneId)}
    >
      <aside
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={activeSurfaceDefinition.title}
        data-testid="mobile-sidecar-host"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.tabs} role="tablist" aria-label="Sidecar surfaces">
            {publication.surfaces.map((surface) => {
              const surfaceDefinition = getSidecarSurfaceDefinition(surface.id);
              const Icon = SIDE_CAR_ICONS[surfaceDefinition.iconId];
              const active = surface.id === activeSurface.id;
              return (
                <button
                  key={surface.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={surfaceDefinition.title}
                  title={surfaceDefinition.title}
                  className={styles.tab}
                  data-active={active ? "true" : "false"}
                  onClick={() => onActiveSurfaceChange(paneId, surface.id)}
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
        <div className={styles.body}>
          {activeSurface.mobileBody ?? activeSurface.body}
        </div>
      </aside>
    </div>
  );
}
