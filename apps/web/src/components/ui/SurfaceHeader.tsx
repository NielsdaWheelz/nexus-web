"use client";

import { forwardRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Folio } from "@/lib/ui/folio";
import ActionMenu, { type ActionMenuOption } from "./ActionMenu";
import RunningHead from "./RunningHead";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

interface SurfaceHeaderProps {
  standingHead: string;
  folio?: Folio;
  folioPending?: boolean;
  actions?: ReactNode;
  options?: ActionMenuOption[];
  navigation: SurfaceHeaderNavigation;
  className?: string;
}

/**
 * The pane-runtime chrome bar: back/forward navigation and the options menu are
 * pane-runtime furniture and stay here; identity is delegated to the
 * {@link RunningHead} (section standing head + typed folio). The accessible page
 * `<h1>` lives in the body's SectionOpener / reader heading, not this bar.
 */
const SurfaceHeader = forwardRef<HTMLElement, SurfaceHeaderProps>(
  function SurfaceHeader(
    {
      standingHead,
      folio,
      folioPending = false,
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
      <header ref={ref} className={headerClassName} data-surface-header="true">
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
          <RunningHead
            standingHead={standingHead}
            folio={folio}
            folioPending={folioPending}
          />
        </div>

        <div className={styles.trailing}>
          {actions && <div className={styles.actions}>{actions}</div>}

          {hasOptions && (
            <ActionMenu
              options={options}
              label="Options"
              className={styles.optionsContainer}
            />
          )}
        </div>
      </header>
    );
  },
);

export default SurfaceHeader;
