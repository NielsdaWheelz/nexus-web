"use client";

import type { PaneSecondarySurfacePublication } from "@/lib/panes/panePublications";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import {
  secondarySurfacePanelId,
  secondarySurfaceTabId,
} from "./SecondarySurfaceTabs";

interface SecondarySurfacePanelsProps {
  baseId: string;
  surfaces: readonly PaneSecondarySurfacePublication[];
  activeSurfaceId: WorkspaceSecondarySurfaceId;
  className: string;
}

/**
 * Owns the tab-to-panel IDREF contract for both desktop and mobile secondary
 * projections. Every tab's controlled panel remains in the DOM; only the
 * active panel mounts publication content.
 */
export default function SecondarySurfacePanels({
  baseId,
  surfaces,
  activeSurfaceId,
  className,
}: SecondarySurfacePanelsProps) {
  return surfaces.map((surface) => {
    const active = surface.id === activeSurfaceId;
    return (
      <div
        key={surface.id}
        id={secondarySurfacePanelId(baseId, surface.id)}
        role="tabpanel"
        aria-labelledby={secondarySurfaceTabId(baseId, surface.id)}
        className={className}
        hidden={!active}
      >
        {active ? surface.body : null}
      </div>
    );
  });
}
