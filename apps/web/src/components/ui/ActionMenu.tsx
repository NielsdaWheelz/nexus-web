"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import styles from "./ActionMenu.module.css";

export interface ActionMenuOption {
  id: string;
  label: string;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
}

interface ActionMenuProps {
  options: ActionMenuOption[];
  /** Label for the trigger button (screen readers). Default: "Actions" */
  label?: string;
  /** Optional class name for the container. */
  className?: string;
}

export default function ActionMenu({
  options,
  label = "Actions",
  className,
}: ActionMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const getFocusableItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"]):not([disabled])'
      )
    );
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    setMenuOpen(false);
    setMenuPos(null);
    requestAnimationFrame(() => {
      toggleRef.current?.focus();
    });
  }, []);

  // Compute fixed position when menu opens
  useEffect(() => {
    if (!menuOpen || !toggleRef.current) return;

    const rect = toggleRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 4,
      left: rect.right,
    });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;

    requestAnimationFrame(() => {
      const [first] = getFocusableItems();
      first?.focus();
    });

    const handlePointerDown = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        menuContainerRef.current &&
        !menuContainerRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
        setMenuPos(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAndRestoreFocus();
      }
    };

    const handleScroll = () => {
      setMenuOpen(false);
      setMenuPos(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [closeAndRestoreFocus, getFocusableItems, menuOpen]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const focusable = getFocusableItems();
    if (focusable.length === 0) return;

    const activeIndex = focusable.findIndex(
      (item) => item === document.activeElement
    );

    if (event.key === "Tab") {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = activeIndex < 0 ? 0 : (activeIndex + 1) % focusable.length;
      focusable[next]?.focus();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev =
        activeIndex < 0
          ? focusable.length - 1
          : (activeIndex - 1 + focusable.length) % focusable.length;
      focusable[prev]?.focus();
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusable[0]?.focus();
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
    }
  };

  if (options.length === 0) return null;

  const containerClassName = [styles.container, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={containerClassName} ref={menuContainerRef}>
      <button
        type="button"
        ref={toggleRef}
        className={styles.trigger}
        aria-haspopup="menu"
        aria-controls={menuOpen ? menuId : undefined}
        aria-expanded={menuOpen}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((open) => !open);
        }}
      >
        &hellip;
      </button>
      {menuOpen && menuPos && (
        <ul
          ref={menuRef}
          id={menuId}
          className={styles.menu}
          role="menu"
          style={{
            position: "fixed",
            top: `${menuPos.top}px`,
            left: `${menuPos.left}px`,
            transform: "translateX(-100%)",
          }}
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option) => (
            <li key={option.id} role="none">
              {option.href ? (
                <a
                  href={option.href}
                  role="menuitem"
                  className={`${styles.menuItem} ${
                    option.tone === "danger" ? styles.menuItemDanger : ""
                  }`}
                  aria-disabled={option.disabled || undefined}
                  tabIndex={option.disabled ? -1 : undefined}
                  onKeyDown={(event: ReactKeyboardEvent<HTMLAnchorElement>) => {
                    if (
                      option.disabled &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                    }
                  }}
                  onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                    event.stopPropagation();
                    if (option.disabled) {
                      event.preventDefault();
                      return;
                    }
                    option.onSelect?.();
                    closeAndRestoreFocus();
                  }}
                >
                  {option.label}
                </a>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.menuItem} ${
                    option.tone === "danger" ? styles.menuItemDanger : ""
                  }`}
                  disabled={option.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    option.onSelect?.();
                    closeAndRestoreFocus();
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
  );
}
