"use client";

import { X } from "lucide-react";
import { useId } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import SecondarySurfaceTabs from "@/components/workspace/SecondarySurfaceTabs";
import SecondarySurfacePanels from "@/components/workspace/SecondarySurfacePanels";
import {
  getPublishedSecondarySurface,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import {
  getSecondarySurfaceDefinition,
  paneSecondaryRegionId,
  type WorkspaceSecondaryState,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useMobileChrome } from "@/lib/workspace/mobileChrome";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import styles from "./MobileSecondaryPaneHost.module.css";

interface MobileSecondaryPaneHostProps {
  primaryPaneId: string;
  secondaryPaneId: string;
  secondary: WorkspaceSecondaryState | null;
  publication: PaneSecondaryPublication | null;
  onClose: (secondaryPaneId: string) => void;
  onActiveSurfaceChange: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  returnFocusTo: ReturnFocusTarget;
}

interface MobileSecondaryPanePresentationProps
  extends MobileSecondaryPaneHostProps {
  options: readonly ActionDescriptor[];
}

/**
 * The only workspace mobile secondary presentation (docs/modules/workspace.md):
 * surface tabs + tabpanel content hosted in the shared MobileSheet primitive.
 * Closing collapses the secondary pane (visibility: "collapsed") without
 * detaching it, so this component stays mounted and `active` toggles — the
 * MobileSheet mount contract (C7 history dismissal) holds.
 */
function MobileSecondaryPanePresentation({
  primaryPaneId,
  secondaryPaneId,
  secondary,
  publication,
  onClose,
  onActiveSurfaceChange,
  returnFocusTo,
  options,
}: MobileSecondaryPanePresentationProps) {
  const baseId = useId();
  const activeSurface = getPublishedSecondarySurface(
    publication,
    secondary?.activeSurfaceId,
  );
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
      panelId={
        publication
          ? paneSecondaryRegionId(primaryPaneId, publication.groupId)
          : undefined
      }
      onDismiss={() => onClose(secondaryPaneId)}
      ariaLabel={activeSurfaceDefinition?.title ?? ""}
      layer="overlay"
      scrim="soft"
      initialFocus={(c) => c.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')}
      returnFocusTo={returnFocusTo}
      returnFocusFallback={() => findPaneChromeFocusTarget(primaryPaneId)}
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
            <ActionMenu
              options={options}
              label="Pane options"
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
          <SecondarySurfacePanels
            baseId={baseId}
            surfaces={publication.surfaces}
            activeSurfaceId={activeSurface.id}
            className={styles.body}
          />
        </>
      ) : null}
    </MobileSheet>
  );
}

export default function MobileSecondaryPaneHost(
  props: MobileSecondaryPaneHostProps,
) {
  const { paneChrome } = useMobileChrome();
  const options =
    paneChrome?.paneId === props.primaryPaneId ? paneChrome.options : [];
  return <MobileSecondaryPanePresentation {...props} options={options} />;
}
