"use client";

import { forwardRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { PaneViewMenuPublication } from "@/lib/panes/panePublications";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import ActionBar from "./ActionBar";
import ActionMenu from "./ActionMenu";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: (modality: "Keyboard" | "Pointer") => void;
  onForward: (modality: "Keyboard" | "Pointer") => void;
}

interface SurfaceHeaderProps {
  header: PaneHeaderModel;
  identityId: string;
  actions?: readonly PaneHeaderAction[];
  /** Dedicated non-resource pane controls (refresh, route share) rendered as buttons. */
  controls?: ReactNode;
  /** The pane's own non-resource view menu (reader settings, date navigation). */
  viewMenu?: PaneViewMenuPublication;
  /** The pane's resource identity → the canonical resource dropdown. */
  resourceTarget?: ResourceActionSubject;
  navigation: SurfaceHeaderNavigation;
  className?: string;
}

/**
 * The pane-runtime chrome bar: back/forward navigation, dedicated pane controls,
 * the pane's own view menu, and the canonical resource dropdown are pane-runtime
 * furniture and stay here; identity is delegated to the typed
 * {@link PaneHeaderIdentity} projection. The resource dropdown is the one
 * {@link ResourceActionMenu} keyed by the pane's `resourceTarget` — the same
 * menu every surface renders — so Open stays in the open pane's own menu (AC6).
 */
const SurfaceHeader = forwardRef<HTMLElement, SurfaceHeaderProps>(
  function SurfaceHeader(
    {
      header,
      identityId,
      actions,
      controls,
      viewMenu,
      resourceTarget,
      navigation,
      className,
    }: SurfaceHeaderProps,
    ref,
  ) {
    const headerClassName = [styles.header, className].filter(Boolean).join(" ");

    return (
      <header
        ref={ref}
        className={headerClassName}
        data-surface-header="true"
      >
        <div className={styles.navigationControls}>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={(event) =>
              navigation.onBack(event.detail === 0 ? "Keyboard" : "Pointer")
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
              navigation.onForward(
                event.detail === 0 ? "Keyboard" : "Pointer",
              )
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
          {actions && actions.length > 0 ? (
            <ActionBar options={actions} label="Pane actions" className={styles.actions} />
          ) : null}

          {controls}

          {viewMenu ? (
            <ActionMenu
              options={viewMenu.actions}
              label={viewMenu.label}
              className={styles.optionsContainer}
              renderTrigger={(props) => (
                <button {...props}>{viewMenu.icon}</button>
              )}
            />
          ) : null}

          {resourceTarget ? (
            <ResourceActionMenu
              target={resourceTarget}
              label="Options"
              placement="below"
              align="end"
            />
          ) : null}
        </div>
      </header>
    );
  },
);

export default SurfaceHeader;
