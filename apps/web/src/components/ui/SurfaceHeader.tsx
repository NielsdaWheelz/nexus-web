"use client";

import { forwardRef, useId, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ActionMenu, { type ActionMenuOption } from "./ActionMenu";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

interface SurfaceHeaderProps {
  title: ReactNode;
  titlePending?: boolean;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  options?: ActionMenuOption[];
  navigation: SurfaceHeaderNavigation;
  headingLevel?: 1 | 2;
  className?: string;
}

const SurfaceHeader = forwardRef<HTMLElement, SurfaceHeaderProps>(function SurfaceHeader(
  {
    title,
    titlePending = false,
    subtitle,
    meta,
    actions,
    options = [],
    navigation,
    headingLevel = 2,
    className,
  }: SurfaceHeaderProps,
  ref
) {
  const HeadingTag = headingLevel === 1 ? "h1" : "h2";
  const hasOptions = options.length > 0;
  const subtitleId = useId();
  const hasSubtitle = Boolean(subtitle);
  const headerClassName = [styles.header, className].filter(Boolean).join(" ");

  return (
    <header
      ref={ref}
      className={headerClassName}
      data-surface-header="true"
      aria-describedby={hasSubtitle ? subtitleId : undefined}
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
        <div className={styles.titles}>
          <HeadingTag
            className={styles.title}
            aria-busy={titlePending || undefined}
          >
            {titlePending ? (
              <>
                <span className={styles.titleSkeleton} aria-hidden />
                <span className="sr-only">{title}</span>
              </>
            ) : (
              title
            )}
          </HeadingTag>
          {meta && <div className={styles.meta}>{meta}</div>}
          {subtitle && (
            <p id={subtitleId} className="sr-only">
              {subtitle}
            </p>
          )}
        </div>
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
});

export default SurfaceHeader;
