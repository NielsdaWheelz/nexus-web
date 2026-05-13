"use client";

import { forwardRef, useId, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import ActionMenu, { type ActionMenuOption } from "./ActionMenu";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./SurfaceHeader.module.css";

export type SurfaceHeaderOption = ActionMenuOption;

interface SurfaceHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  options?: SurfaceHeaderOption[];
  headingLevel?: 1 | 2;
  className?: string;
  onBack?: () => void;
  onOptionsOpenChange?: (open: boolean) => void;
}

const SurfaceHeader = forwardRef<HTMLElement, SurfaceHeaderProps>(function SurfaceHeader(
  {
    title,
    subtitle,
    meta,
    actions,
    options = [],
    headingLevel = 2,
    className,
    onBack,
    onOptionsOpenChange,
  }: SurfaceHeaderProps,
  ref
) {
  const HeadingTag = headingLevel === 1 ? "h1" : "h2";
  const hasOptions = options.length > 0;
  const subtitleId = useId();
  const hasSubtitle = Boolean(subtitle);
  const isMobile = useIsMobileViewport();
  const headerClassName = [styles.header, isMobile ? styles.mobile : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <header
      ref={ref}
      className={headerClassName}
      data-surface-header="true"
      data-mobile={isMobile ? "true" : undefined}
      aria-describedby={hasSubtitle ? subtitleId : undefined}
    >
      <div className={styles.leading}>
        {onBack && (
          <button
            type="button"
            className={styles.backButton}
            onClick={onBack}
            aria-label="Go back"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <div className={styles.titles}>
          <HeadingTag className={styles.title}>{title}</HeadingTag>
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
            onOpenChange={onOptionsOpenChange}
          />
        )}
      </div>
    </header>
  );
});

export default SurfaceHeader;
