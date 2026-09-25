"use client";

import { forwardRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { PaneCompanionAction } from "@/lib/panes/panePublications";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import ActionBar from "./ActionBar";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
import styles from "./SurfaceHeader.module.css";
import { pointerModality } from "@/lib/ui/pointerModality";

export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: (modality: "Keyboard" | "Pointer") => void;
  onForward: (modality: "Keyboard" | "Pointer") => void;
}

interface SurfaceHeaderProps {
  header: PaneHeaderModel;
  identityId: string;
  companionAction?: PaneCompanionAction;
  paneActions?: readonly ActionDescriptor[];
  menuActions?: readonly ActionDescriptor[];
  actionSubject?: ResourceActionSubject;
  navigation: SurfaceHeaderNavigation;
}

/**
 * The pane-runtime chrome bar projects stable navigation, one contextual More
 * menu, and then the one promoted inspector action, labelled so it never
 * collapses; the identity yields width first. Resource actions stay owned by
 * their canonical runtime and are appended by ContextualActionMenu.
 */
const SurfaceHeader = forwardRef<HTMLElement, SurfaceHeaderProps>(
  function SurfaceHeader(
    {
      header,
      identityId,
      companionAction,
      paneActions = [],
      menuActions = [],
      actionSubject,
      navigation,
    }: SurfaceHeaderProps,
    ref,
  ) {
    const hasMoreContent =
      paneActions.length > 0 ||
      menuActions.length > 0 ||
      actionSubject !== undefined;

    return (
      <header
        ref={ref}
        className={styles.header}
        data-surface-header="true"
      >
        <div className={styles.navigationControls}>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={(event) =>
              navigation.onBack(pointerModality(event))
            }
            disabled={!navigation.canGoBack}
            aria-label="Go back in this pane"
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={(event) =>
              navigation.onForward(pointerModality(event))
            }
            disabled={!navigation.canGoForward}
            aria-label="Go forward in this pane"
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.identity}>
          <PaneHeaderIdentity
            id={identityId}
            model={header}
            projection="Desktop"
          />
        </div>

        <div className={styles.trailing}>
          {hasMoreContent ? (
            <ContextualActionMenu
              label="More"
              placement="below"
              align="end"
              sections={[
                { id: "Pane", actions: paneActions },
                { id: "View", actions: menuActions },
              ]}
              actionSubject={actionSubject}
              renderTrigger={(props) => (
                <button {...props}>
                  &hellip;
                  {[...paneActions, ...menuActions].some(
                    (action) => action.indicator?.kind === "Status",
                  ) ? (
                    <span
                      className={styles.menuStatusMarker}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              )}
            />
          ) : null}

          {companionAction ? (
            <ActionBar
              options={[companionAction]}
              label="Pane actions"
              showLabels
              className={styles.actions}
            />
          ) : null}
        </div>
      </header>
    );
  },
);

export default SurfaceHeader;
