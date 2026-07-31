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
  type PaneSecondaryPresentationSurfacePublication,
  type PaneTransientSecondarySurfacePublication,
} from "@/lib/panes/panePublications";
import {
  getPaneSecondarySurfaceDefinition,
  isPaneTransientSecondarySurfaceId,
  paneSecondaryRegionId,
  type WorkspaceSecondaryState,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useMobileChrome } from "@/lib/workspace/mobileChrome";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import styles from "./MobileSecondaryPaneHost.module.css";

interface MobileSecondaryPaneHostProps {
  primaryPaneId: string;
  secondaryPaneId: string;
  secondary: WorkspaceSecondaryState | null;
  publication: PaneSecondaryPublication | null;
  transientSurface?: PaneTransientSecondarySurfacePublication | null;
  transientExpanded?: boolean;
  onClose: (secondaryPaneId: string) => void;
  onCloseTransient?: () => void;
  onActiveSurfaceChange: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onSelectDurableFromTransient?: (
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
  transientSurface = null,
  transientExpanded = false,
  onClose,
  onCloseTransient,
  onActiveSurfaceChange,
  onSelectDurableFromTransient,
  returnFocusTo,
  options,
}: MobileSecondaryPanePresentationProps) {
  const baseId = useId();
  const activeSurface =
    transientSurface ??
    getPublishedSecondarySurface(publication, secondary?.activeSurfaceId);
  const activeSurfaceDefinition = activeSurface
    ? getPaneSecondarySurfaceDefinition(activeSurface.id)
    : null;
  const durableActive = Boolean(
    !transientSurface &&
      secondary?.visibility === "visible" &&
      publication &&
      secondary.groupId === publication.groupId &&
      activeSurface,
  );
  const active = transientSurface ? transientExpanded : durableActive;
  const surfaces: readonly PaneSecondaryPresentationSurfacePublication[] =
    publication && transientSurface
      ? [...publication.surfaces, transientSurface]
      : (publication?.surfaces ?? []);
  const showTabs = Boolean(publication && publication.surfaces.length > 0);
  if (
    transientSurface &&
    (!onCloseTransient || !onSelectDurableFromTransient)
  ) {
    throw new Error(
      "Transient secondary presentation requires close and durable-select commands.",
    );
  }
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
    <MobileSheet
      active={active}
      panelId={
        publication
          ? paneSecondaryRegionId(primaryPaneId, publication.groupId)
          : undefined
      }
      onDismiss={close}
      ariaLabel={activeSurfaceDefinition?.title ?? ""}
      layer="overlay"
      scrim="soft"
      initialFocus={(container) =>
        container.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"], [data-secondary-close="true"]',
        )
      }
      returnFocusTo={returnFocusTo}
      returnFocusFallback={() => findPaneLandmarkFocusTarget(primaryPaneId)}
      skipReturnFocus={() =>
        Boolean(transientSurface && !transientExpanded)
      }
      focusKey={activeSurface?.id ?? null}
      backdropTestId="mobile-secondary-backdrop"
      panelTestId="mobile-secondary-host"
    >
      {publication && activeSurface && activeSurfaceDefinition ? (
        <>
          <header className={styles.header}>
            {showTabs ? (
              <SecondarySurfaceTabs
                baseId={baseId}
                surfaces={surfaces}
                activeSurfaceId={activeSurface.id}
                onSelect={(surfaceId) => {
                  if (!isPaneTransientSecondarySurfaceId(surfaceId)) {
                    if (selectDurableFromTransient) {
                      selectDurableFromTransient(
                        secondaryPaneId,
                        surfaceId,
                      );
                    } else {
                      onActiveSurfaceChange(secondaryPaneId, surfaceId);
                    }
                  }
                }}
              />
            ) : (
              <span className={styles.soloTitle}>
                {activeSurfaceDefinition.title}
              </span>
            )}
            <ActionMenu
              options={options}
              label="Pane options"
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Close ${activeSurfaceDefinition.title}`}
              data-secondary-close="true"
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
            <div className={styles.body}>{activeSurface.body}</div>
          )}
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
