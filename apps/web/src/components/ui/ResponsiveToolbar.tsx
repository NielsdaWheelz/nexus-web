"use client";

import { type ReactNode } from "react";
import ActionMenu from "./ActionMenu";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./ResponsiveToolbar.module.css";

export interface ToolbarItem {
  id: string;
  /** Full text label. Used as button text on desktop, aria-label on mobile when icon is present. */
  label: string;
  /** Icon element. When present, replaces text on mobile for compact display. */
  icon?: ReactNode;
  /** Click handler. */
  onClick?: () => void;
  /** Whether the button is disabled. */
  disabled?: boolean;
  /**
   * Priority level for responsive behavior.
   * - 'primary': stays visible on mobile (as icon-only when icon provided)
   * - 'secondary': collapses into overflow menu on mobile
   * Default: 'primary'
   */
  priority?: "primary" | "secondary";
}

interface ResponsiveToolbarProps {
  /** Structured toolbar items with priority-based overflow. */
  items: ToolbarItem[];
  /** Display-only elements (labels, selects) rendered inline on all viewports. */
  displays?: ReactNode;
  /** Accessible label for the toolbar region. */
  ariaLabel?: string;
  /** Optional className for the toolbar container. */
  className?: string;
}

export default function ResponsiveToolbar({
  items,
  displays,
  ariaLabel,
  className,
}: ResponsiveToolbarProps) {
  const isMobile = useIsMobileViewport();

  const primaryItems = items.filter((item) => (item.priority ?? "primary") === "primary");
  const secondaryItems = items.filter((item) => item.priority === "secondary");

  const containerClassName = [styles.toolbar, className].filter(Boolean).join(" ");

  return (
    <div className={containerClassName} role="toolbar" aria-label={ariaLabel}>
      {/* Primary items: full text on desktop, icon-only on mobile */}
      {primaryItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className={styles.toolbarBtn}
          onClick={item.onClick}
          disabled={item.disabled}
          aria-label={isMobile && item.icon ? item.label : undefined}
        >
          {isMobile && item.icon ? item.icon : item.label}
        </button>
      ))}

      {/* Display elements (labels, selects, etc.) — always inline */}
      {displays}

      {/* Desktop: render secondary items inline as text buttons */}
      {!isMobile &&
        secondaryItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={styles.toolbarBtn}
            onClick={item.onClick}
            disabled={item.disabled}
          >
            {item.label}
          </button>
        ))}

      {/* Mobile: collapse secondary items into overflow menu */}
      {isMobile && secondaryItems.length > 0 && (
        <ActionMenu
          label="More actions"
          options={secondaryItems.map((item) => ({
            id: item.id,
            label: item.label,
            onSelect: item.onClick,
            disabled: item.disabled,
          }))}
        />
      )}
    </div>
  );
}
