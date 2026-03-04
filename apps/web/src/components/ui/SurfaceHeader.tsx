"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface SurfaceHeaderNavigation {
  label?: string;
  previous?: SurfaceHeaderAction;
  next?: SurfaceHeaderAction;
}

export interface SurfaceHeaderBackAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface SurfaceHeaderOption {
  id: string;
  label: string;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
}

interface SurfaceHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  back?: SurfaceHeaderBackAction;
  navigation?: SurfaceHeaderNavigation;
  actions?: ReactNode;
  options?: SurfaceHeaderOption[];
  headingLevel?: 1 | 2;
  className?: string;
}

export default function SurfaceHeader({
  title,
  subtitle,
  meta,
  back,
  navigation,
  actions,
  options = [],
  headingLevel = 2,
  className,
}: SurfaceHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const optionsToggleRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const optionsMenuId = useId();
  const HeadingTag = headingLevel === 1 ? "h1" : "h2";
  const hasOptions = options.length > 0;
  const headerClassName = useMemo(
    () => [styles.header, className].filter(Boolean).join(" "),
    [className]
  );
  const getFocusableMenuItems = useCallback((): HTMLElement[] => {
    if (!optionsRef.current) {
      return [];
    }
    return Array.from(
      optionsRef.current.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"]):not([disabled])'
      )
    );
  }, []);
  const closeMenuAndRestoreFocus = useCallback(() => {
    setMenuOpen(false);
    requestAnimationFrame(() => {
      optionsToggleRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    requestAnimationFrame(() => {
      const [firstItem] = getFocusableMenuItems();
      firstItem?.focus();
    });

    const handlePointerDown = (event: MouseEvent) => {
      if (!optionsRef.current) {
        return;
      }
      if (!optionsRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenuAndRestoreFocus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenuAndRestoreFocus, getFocusableMenuItems, menuOpen]);

  const handleOptionsMenuKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const focusableItems = getFocusableMenuItems();
    if (focusableItems.length === 0) {
      return;
    }

    const activeIndex = focusableItems.findIndex(
      (item) => item === document.activeElement
    );

    if (event.key === "Tab") {
      const firstItem = focusableItems[0];
      const lastItem = focusableItems[focusableItems.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % focusableItems.length;
      focusableItems[nextIndex]?.focus();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prevIndex =
        activeIndex < 0
          ? focusableItems.length - 1
          : (activeIndex - 1 + focusableItems.length) % focusableItems.length;
      focusableItems[prevIndex]?.focus();
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusableItems[0]?.focus();
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusableItems[focusableItems.length - 1]?.focus();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenuAndRestoreFocus();
    }
  };

  const renderBackControl = () => {
    if (!back) {
      return null;
    }

    if (back.href) {
      return (
        <Link href={back.href} className={styles.backButton} aria-label={back.label}>
          {back.label}
        </Link>
      );
    }

    if (!back.onClick) {
      return null;
    }

    return (
      <button
        type="button"
        className={styles.backButton}
        onClick={back.onClick}
        aria-label={back.label}
      >
        {back.label}
      </button>
    );
  };

  return (
    <header className={headerClassName} data-surface-header="true">
      <div className={styles.leading}>
        {renderBackControl()}
        <div className={styles.titles}>
          <HeadingTag className={styles.title}>{title}</HeadingTag>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
      </div>

      <div className={styles.trailing}>
        {navigation && (
          <div className={styles.navigation} aria-label="Surface navigation">
            {navigation.previous && (
              <button
                type="button"
                className={styles.navButton}
                onClick={navigation.previous.onClick}
                disabled={navigation.previous.disabled}
                aria-label={navigation.previous.label}
              >
                {navigation.previous.label}
              </button>
            )}
            {navigation.label && <span className={styles.navigationLabel}>{navigation.label}</span>}
            {navigation.next && (
              <button
                type="button"
                className={styles.navButton}
                onClick={navigation.next.onClick}
                disabled={navigation.next.disabled}
                aria-label={navigation.next.label}
              >
                {navigation.next.label}
              </button>
            )}
          </div>
        )}

        {actions && <div className={styles.actions}>{actions}</div>}

        {hasOptions && (
          <div className={styles.optionsContainer} ref={optionsRef}>
            <button
              type="button"
              ref={optionsToggleRef}
              className={styles.optionsToggle}
              aria-haspopup="menu"
              aria-controls={menuOpen ? optionsMenuId : undefined}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              Options
            </button>
            {menuOpen && (
              <ul
                id={optionsMenuId}
                className={styles.optionsMenu}
                role="menu"
                onKeyDown={handleOptionsMenuKeyDown}
              >
                {options.map((option) => (
                  <li key={option.id} role="none">
                    {option.href ? (
                      <Link
                        href={option.href}
                        role="menuitem"
                        className={`${styles.optionItem} ${
                          option.tone === "danger" ? styles.optionItemDanger : ""
                        }`}
                        aria-disabled={option.disabled || undefined}
                        tabIndex={option.disabled ? -1 : undefined}
                        onKeyDown={(event) => {
                          if (
                            option.disabled &&
                            (event.key === "Enter" || event.key === " ")
                          ) {
                            event.preventDefault();
                          }
                        }}
                        onClick={(event) => {
                          if (option.disabled) {
                            event.preventDefault();
                            return;
                          }
                          option.onSelect?.();
                          closeMenuAndRestoreFocus();
                        }}
                      >
                        {option.label}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className={`${styles.optionItem} ${
                          option.tone === "danger" ? styles.optionItemDanger : ""
                        }`}
                        disabled={option.disabled}
                        onClick={() => {
                          option.onSelect?.();
                                  closeMenuAndRestoreFocus();
                        }}
                      >
                        {option.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
