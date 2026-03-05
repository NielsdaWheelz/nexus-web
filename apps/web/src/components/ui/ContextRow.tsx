"use client";

import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import styles from "./ContextRow.module.css";

interface ContextRowProps {
  className?: string;
  mainClassName?: string;
  leadingClassName?: string;
  contentClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  metaClassName?: string;
  trailingClassName?: string;
  actionsClassName?: string;
  expandedClassName?: string;
  style?: CSSProperties;
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  expandedContent?: ReactNode;
  href?: string;
  target?: string;
  rel?: string;
  onMainClick?: (event: MouseEvent<HTMLElement>) => void;
  onMainKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  mainRole?: string;
  mainTabIndex?: number;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
}

function cx(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(" ");
}

export default function ContextRow({
  className,
  mainClassName,
  leadingClassName,
  contentClassName,
  titleClassName,
  descriptionClassName,
  metaClassName,
  trailingClassName,
  actionsClassName,
  expandedClassName,
  style,
  leading,
  title,
  description,
  meta,
  trailing,
  actions,
  expandedContent,
  href,
  target,
  rel,
  onMainClick,
  onMainKeyDown,
  onMouseEnter,
  onMouseLeave,
  mainRole,
  mainTabIndex,
  ariaPressed,
  ariaExpanded,
}: ContextRowProps) {
  const mainContent = (
    <>
      {leading && <span className={cx(styles.leading, leadingClassName)}>{leading}</span>}
      <span className={cx(styles.content, contentClassName)}>
        <span className={cx(styles.title, titleClassName)}>{title}</span>
        {description && (
          <span className={cx(styles.description, descriptionClassName)}>{description}</span>
        )}
        {meta && <span className={cx(styles.meta, metaClassName)}>{meta}</span>}
      </span>
      {trailing && <span className={cx(styles.trailing, trailingClassName)}>{trailing}</span>}
    </>
  );

  const rowMainClassName = cx(styles.main, mainClassName);
  const sharedMainProps = {
    className: rowMainClassName,
    onClick: onMainClick as ((event: MouseEvent<HTMLDivElement>) => void) | undefined,
    onKeyDown: onMainKeyDown as ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined,
    role: mainRole,
    tabIndex: mainTabIndex,
    "aria-pressed": ariaPressed,
    "aria-expanded": ariaExpanded,
  };

  return (
    <div
      className={cx(styles.row, className)}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {href ? (
        <a
          href={href}
          target={target}
          rel={rel}
          className={rowMainClassName}
          onClick={onMainClick as ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined}
          onKeyDown={onMainKeyDown as ((event: KeyboardEvent<HTMLAnchorElement>) => void) | undefined}
          role={mainRole}
          tabIndex={mainTabIndex}
          aria-pressed={ariaPressed}
          aria-expanded={ariaExpanded}
        >
          {mainContent}
        </a>
      ) : (
        <div {...sharedMainProps}>{mainContent}</div>
      )}

      {actions && <div className={cx(styles.actions, actionsClassName)}>{actions}</div>}
      {expandedContent && (
        <div className={cx(styles.expanded, expandedClassName)}>{expandedContent}</div>
      )}
    </div>
  );
}
