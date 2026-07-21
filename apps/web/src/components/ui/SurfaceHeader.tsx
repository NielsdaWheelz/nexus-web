"use client";

import { forwardRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import ActionBar from "./ActionBar";
import ActionMenu from "./ActionMenu";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

interface SurfaceHeaderProps {
  header: PaneHeaderModel;
  identityId: string;
  actions?: readonly PaneHeaderAction[];
  options?: readonly ActionDescriptor[];
  navigation: SurfaceHeaderNavigation;
  className?: string;
}

/**
 * The pane-runtime chrome bar: back/forward navigation and the options menu are
 * pane-runtime furniture and stay here; identity is delegated to the typed
 * {@link PaneHeaderIdentity} projection.
 */
const SurfaceHeader = forwardRef<HTMLElement, SurfaceHeaderProps>(
  function SurfaceHeader(
    {
      header,
      identityId,
      actions,
      options = [],
      navigation,
      className,
    }: SurfaceHeaderProps,
    ref,
  ) {
    const hasOptions = options.length > 0;
    const headerClassName = [styles.header, className].filter(Boolean).join(" ");

    return (
      <header
        ref={ref}
        className={headerClassName}
        data-surface-header="true"
        data-header-kind={header.kind}
      >
        <div className={styles.leading}>
          <div className={styles.navigationControls}>
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
          <PaneHeaderIdentity id={identityId} model={header} />
        </div>

        <div className={styles.trailing}>
          {actions && actions.length > 0 ? (
            <ActionBar options={actions} label="Pane actions" className={styles.actions} />
          ) : null}

          {hasOptions && (
            <ActionMenu
              options={options}
              label="Options"
              className={styles.optionsContainer}
              triggerAttributes={{ "data-pane-options-trigger": "true" }}
            />
          )}
        </div>
      </header>
    );
  },
);

export default SurfaceHeader;
