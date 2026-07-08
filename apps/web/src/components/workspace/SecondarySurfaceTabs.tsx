"use client";

import { useRef } from "react";
import type { ComponentType } from "react";
import {
  BarChart3,
  GitBranch,
  Link2,
  ListTree,
} from "lucide-react";
import type { PaneSecondarySurfacePublication } from "@/lib/panes/panePublications";
import { getSecondarySurfaceDefinition } from "@/lib/panes/paneSecondaryModel";
import type {
  PaneSecondaryIconId,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import styles from "./SecondarySurfaceTabs.module.css";

const SECONDARY_ICONS: Record<
  PaneSecondaryIconId,
  ComponentType<{ size?: number; "aria-hidden"?: "true" }>
> = {
  "bar-chart-3": BarChart3,
  "git-branch": GitBranch,
  "link-2": Link2,
  "list-tree": ListTree,
};

export function secondarySurfaceTabId(
  baseId: string,
  surfaceId: WorkspaceSecondarySurfaceId,
): string {
  return `${baseId}-${surfaceId}-tab`;
}

export function secondarySurfacePanelId(
  baseId: string,
  surfaceId: WorkspaceSecondarySurfaceId,
): string {
  return `${baseId}-${surfaceId}-panel`;
}

interface SecondarySurfaceTabsProps {
  baseId: string;
  surfaces: readonly PaneSecondarySurfacePublication[];
  activeSurfaceId: WorkspaceSecondarySurfaceId;
  onSelect: (surfaceId: WorkspaceSecondarySurfaceId) => void;
}

/**
 * The roving-focus tablist shared by the desktop secondary shell and the mobile
 * secondary sheet. It owns the icon map, tab markup, keyboard model
 * (ArrowLeft/ArrowRight/Home/End), and focus-follows-selection so both surfaces
 * expose the same tab capability contract. Panel linkage ids are produced by the
 * exported helpers so the owning shell can label its single tabpanel against the
 * active tab.
 */
export default function SecondarySurfaceTabs({
  baseId,
  surfaces,
  activeSurfaceId,
  onSelect,
}: SecondarySurfaceTabsProps) {
  const tabRefs = useRef(new Map<WorkspaceSecondarySurfaceId, HTMLButtonElement>());

  const selectSurface = (surfaceId: WorkspaceSecondarySurfaceId) => {
    onSelect(surfaceId);
    window.requestAnimationFrame(() => tabRefs.current.get(surfaceId)?.focus());
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label="Secondary surfaces">
      {surfaces.map((surface, index) => {
        const definition = getSecondarySurfaceDefinition(surface.id);
        const Icon = SECONDARY_ICONS[definition.iconId];
        const active = surface.id === activeSurfaceId;
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
            id={secondarySurfaceTabId(baseId, surface.id)}
            type="button"
            role="tab"
            aria-controls={secondarySurfacePanelId(baseId, surface.id)}
            aria-selected={active}
            aria-label={definition.title}
            title={definition.title}
            tabIndex={active ? 0 : -1}
            className={styles.tab}
            data-active={active ? "true" : "false"}
            onClick={() => selectSurface(surface.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const direction = event.key === "ArrowRight" ? 1 : -1;
                const nextIndex =
                  (index + direction + surfaces.length) % surfaces.length;
                const nextSurface = surfaces[nextIndex];
                if (nextSurface) {
                  selectSurface(nextSurface.id);
                }
              } else if (event.key === "Home") {
                event.preventDefault();
                const firstSurface = surfaces[0];
                if (firstSurface) {
                  selectSurface(firstSurface.id);
                }
              } else if (event.key === "End") {
                event.preventDefault();
                const lastSurface = surfaces[surfaces.length - 1];
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
  );
}
