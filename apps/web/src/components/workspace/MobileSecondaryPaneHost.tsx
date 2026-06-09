"use client";

import { X } from "lucide-react";
import { useId } from "react";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
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

/**
 * The only workspace mobile secondary presentation (docs/modules/workspace.md):
 * surface tabs + tabpanel content hosted in the shared MobileSheet primitive.
 * Closing collapses the secondary pane (visibility: "collapsed") without
 * detaching it, so this component stays mounted and `active` toggles — the
 * MobileSheet mount contract (C7 history dismissal) holds.
 */
export default function MobileSecondaryPaneHost({
  secondaryPaneId,
  secondary,
  publication,
  onClose,
  onActiveSurfaceChange,
}: MobileSecondaryPaneHostProps) {
  const baseId = useId();
  const activeSurface =
    publication?.surfaces.find((surface) => surface.id === secondary?.activeSurfaceId) ??
    null;
  const activeSurfaceDefinition = activeSurface
    ? getSecondarySurfaceDefinition(activeSurface.id)
    : null;
  const active = Boolean(
    secondary?.visibility === "visible" &&
      publication &&
      secondary.groupId === publication.groupId &&
      activeSurface,
  );

  return (
    <MobileSheet
      active={active}
      onDismiss={() => onClose(secondaryPaneId)}
      ariaLabel={activeSurfaceDefinition?.title ?? ""}
      layer="overlay"
      scrim="soft"
      initialFocus={(c) => c.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')}
      returnFocusFallback={() =>
        document.querySelector<HTMLElement>('[data-active="true"] [data-pane-chrome-focus="true"]')
      }
      focusKey={activeSurface?.id ?? null}
      backdropTestId="mobile-secondary-backdrop"
      panelTestId="mobile-secondary-host"
    >
      {publication && activeSurface && activeSurfaceDefinition ? (
        <>
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
        </>
      ) : null}
    </MobileSheet>
  );
}
