"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import styles from "./ActionMenu.module.css";

export interface ActionMenuOption {
  id: string;
  label: string;
  onSelect?: (detail: { triggerEl: HTMLButtonElement | null }) => void;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  restoreFocusOnClose?: boolean;
  separatorBefore?: boolean;
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
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const triggerId = useId();
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

  const closeMenu = useCallback((restoreFocus: boolean = true) => {
    setMenuOpen(false);
    setMenuPos(null);
    if (!restoreFocus) {
      return;
    }
    requestAnimationFrame(() => {
      toggleRef.current?.focus();
    });
  }, []);

  const openMenu = useCallback((focusTarget: "first" | "last" = "first") => {
    setInitialFocus(focusTarget);
    setMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const updateMenuPos = () => {
      if (!toggleRef.current) return;
      const rect = toggleRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4,
        left: rect.right,
      });
    };

    updateMenuPos();

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
        closeMenu();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", updateMenuPos, true);
    window.addEventListener("resize", updateMenuPos);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", updateMenuPos, true);
      window.removeEventListener("resize", updateMenuPos);
    };
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (!menuOpen || !menuPos) return;

    requestAnimationFrame(() => {
      const focusable = getFocusableItems();
      const target =
        initialFocus === "last"
          ? focusable[focusable.length - 1]
          : focusable[0];
      target?.focus();
    });
  }, [getFocusableItems, initialFocus, menuOpen, menuPos]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    event.stopPropagation();
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

    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const prefix = event.key.toLocaleLowerCase();
      const startIndex = activeIndex < 0 ? 0 : activeIndex + 1;
      const orderedItems = [
        ...focusable.slice(startIndex),
        ...focusable.slice(0, startIndex),
      ];
      const next = orderedItems.find((item) =>
        item.textContent?.trim().toLocaleLowerCase().startsWith(prefix)
      );
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  if (options.length === 0) return null;

  const containerClassName = [styles.container, className]
    .filter(Boolean)
    .join(" ");

  const menu =
    menuOpen && menuPos ? (
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
        aria-labelledby={triggerId}
        onKeyDown={handleMenuKeyDown}
      >
        {options.map((option, index) => (
          <Fragment key={option.id}>
            {option.separatorBefore && index > 0 ? (
              <li role="separator" className={styles.separator} />
            ) : null}
            <li role="none">
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
                    option.onSelect?.({ triggerEl: toggleRef.current });
                    closeMenu(option.restoreFocusOnClose !== false);
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
                    option.onSelect?.({ triggerEl: toggleRef.current });
                    closeMenu(option.restoreFocusOnClose !== false);
                  }}
                >
                  {option.label}
                </button>
              )}
            </li>
          </Fragment>
        ))}
      </ul>
    ) : null;

  return (
    <div
      className={containerClassName}
      ref={menuContainerRef}
      data-open={menuOpen ? "true" : "false"}
    >
      <button
        type="button"
        id={triggerId}
        ref={toggleRef}
        className={styles.trigger}
        aria-haspopup="menu"
        aria-controls={menuOpen ? menuId : undefined}
        aria-expanded={menuOpen}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) {
            closeMenu(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" ||
            event.key === " " ||
            event.key === "ArrowDown"
          ) {
            event.preventDefault();
            event.stopPropagation();
            openMenu("first");
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            openMenu("last");
          }
        }}
      >
        &hellip;
      </button>
      {menu && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : null}
    </div>
  );
}
