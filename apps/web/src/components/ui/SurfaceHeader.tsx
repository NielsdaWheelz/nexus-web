"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import type { PaneCompanionAction } from "@/lib/panes/paneChrome";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import {
  projectActionControlState,
  type ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import Button from "./Button";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

/**
 * A desktop pane's chrome bar: back and forward, the identity (which yields
 * width first), one More menu (pane, view, then the resource's own actions)
 * and the labelled Inspector companion, which never collapses.
 */
export default function SurfaceHeader({
  header,
  identityId,
  companionAction: companion,
  paneActions = [],
  menuActions = [],
  actionSubject,
  navigation,
}: {
  header: PaneHeaderModel;
  identityId: string;
  companionAction?: PaneCompanionAction;
  paneActions?: readonly ActionDescriptor[];
  menuActions?: readonly ActionDescriptor[];
  actionSubject?: ResourceActionSubject;
  navigation: SurfaceHeaderNavigation;
}) {
  const actions = [...paneActions, ...menuActions];
  const companionState =
    companion && projectActionControlState(companion.label, companion.state);
  return (
    <header className={styles.header}>
      <div className={styles.navigation}>
        <button
          type="button"
          className={styles.navigationButton}
          onClick={navigation.onBack}
          disabled={!navigation.canGoBack}
          aria-label="Go back in this pane"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.navigationButton}
          onClick={navigation.onForward}
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
        {actions.length > 0 || actionSubject !== undefined ? (
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
                {actions.some(
                  (action) => action.indicator?.kind === "Status",
                ) ? (
                  <span className={styles.statusMarker} aria-hidden="true" />
                ) : null}
              </button>
            )}
          />
        ) : null}
        {companion && companionState ? (
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={companion.icon}
            disabled={companion.disabled}
            title={companionState.menuLabel}
            aria-pressed={companionState.barPressed}
            aria-expanded={companionState.barExpanded}
            aria-controls={companionState.barControls}
            data-action-id={companion.id}
            className={cx(
              styles.companion,
              companionState.active && styles.pressed,
            )}
            onClick={(event) => {
              event.stopPropagation();
              companion.onSelect({ triggerEl: event.currentTarget });
            }}
          >
            {companion.label}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
