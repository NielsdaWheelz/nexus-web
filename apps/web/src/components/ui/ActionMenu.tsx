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
  type ButtonHTMLAttributes,
  type Ref,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  projectActionControlState,
  type ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import {
  useContainingModalLayer,
  useIsModalLayerTopmost,
} from "@/lib/ui/useModalLayer";
import styles from "./ActionMenu.module.css";

/** Wiring a custom trigger must spread onto its focusable element. */
type ActionMenuTriggerAttributes = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "tabIndex"
> &
  Partial<Record<`data-${string}`, string | undefined>>;

interface ActionMenuTriggerProps extends ActionMenuTriggerAttributes {
  ref: Ref<HTMLButtonElement>;
  id: string;
  "aria-haspopup": "menu";
  "aria-controls": string | undefined;
  "aria-expanded": boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

interface ActionMenuProps {
  options: readonly ActionDescriptor[];
  /** Label for the trigger button (screen readers). Default: "Actions" */
  label?: string;
  /** Optional class name for the container. */
  className?: string;
  onOpenChange?: (open: boolean) => void;
  /** Menu placement relative to the trigger. Default "below". */
  placement?: "below" | "above";
  /** Menu cross-axis alignment. Default "end". */
  align?: "start" | "center" | "end";
  /** Render a custom trigger (e.g. an avatar); defaults to the "…" overflow button. */
  renderTrigger?: (props: ActionMenuTriggerProps) => ReactNode;
  /** Extra attributes for composite widgets that keep their trigger programmatic. */
  triggerAttributes?: ActionMenuTriggerAttributes;
}

const MENU_ITEM_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]):not([disabled]), ' +
  '[role="menuitemcheckbox"]:not([aria-disabled="true"]):not([disabled])';
const TABBABLE_SELECTOR = [
  'a[href]:not([aria-disabled="true"])',
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function resolvePortalContainer(
  trigger: HTMLButtonElement | null,
  modalOwned: boolean,
): HTMLElement {
  if (!modalOwned) return document.body;
  const modal = trigger?.closest<HTMLElement>('[role="dialog"]');
  if (!modal) {
    throw new Error(
      "A modal-owned ActionMenu requires a containing dialog element.",
    );
  }
  return modal;
}

export default function ActionMenu({
  options,
  label = "Actions",
  className,
  onOpenChange,
  placement = "below",
  align = "end",
  renderTrigger,
  triggerAttributes,
}: ActionMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  const menuId = useId();
  const modalToken = useContainingModalLayer();
  const modalIsTopmost = useIsModalLayerTopmost(modalToken);
  const {
    ref: menuRef,
    style: menuStyle,
    anchorRect,
  } = useAnchoredPosition<HTMLUListElement>(toggleRef.current, {
    enabled: menuOpen,
    placement,
    align,
    gap: 4,
  });

  const getMenuItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
    );
  }, [menuRef]);

  const getTabbableItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(menuRef.current.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
      (item) => item.tabIndex >= 0,
    );
  }, [menuRef]);

  const closeMenu = useCallback((restoreFocus: boolean = true) => {
    setMenuOpen(false);
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
    onOpenChange?.(menuOpen);
    return () => {
      if (menuOpen) {
        onOpenChange?.(false);
      }
    };
  }, [menuOpen, onOpenChange]);

  useDismissOnOutsideOrEscape({
    enabled: menuOpen,
    refs: [menuRef, menuContainerRef],
    onDismiss: (reason) => closeMenu(reason === "escape"),
  });
  useHistoryDismiss(
    menuOpen && modalToken !== null,
    () => {
      closeMenu();
      return "accepted";
    },
    { isTopmost: modalIsTopmost },
  );

  useEffect(() => {
    if (!menuOpen || !anchorRect) return;

    requestAnimationFrame(() => {
      const menuItems = getMenuItems();
      const tabbableItems = getTabbableItems();
      const focusable = menuItems.length ? menuItems : tabbableItems;
      const target =
        initialFocus === "last"
          ? focusable[focusable.length - 1]
          : focusable[0];
      target?.focus();
    });
  }, [getMenuItems, getTabbableItems, initialFocus, menuOpen, anchorRect]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    event.stopPropagation();

    if (event.key === "Tab") {
      const tabbableItems = getTabbableItems();
      if (tabbableItems.length === 0) return;
      const first = tabbableItems[0];
      const last = tabbableItems[tabbableItems.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }

    const menuItems = getMenuItems();
    if (menuItems.length === 0) return;

    const activeIndex = menuItems.findIndex(
      (item) => item === document.activeElement
    );

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = activeIndex < 0 ? 0 : (activeIndex + 1) % menuItems.length;
      menuItems[next]?.focus();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev =
        activeIndex < 0
          ? menuItems.length - 1
          : (activeIndex - 1 + menuItems.length) % menuItems.length;
      menuItems[prev]?.focus();
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      menuItems[0]?.focus();
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      menuItems[menuItems.length - 1]?.focus();
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
        ...menuItems.slice(startIndex),
        ...menuItems.slice(0, startIndex),
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
  };

  if (options.length === 0) return null;

  const containerClassName = [styles.container, className]
    .filter(Boolean)
    .join(" ");

  const menu =
    menuOpen ? (
      <ul
        ref={menuRef}
        id={menuId}
        className={styles.menu}
        role="menu"
        style={menuStyle}
        aria-labelledby={triggerId}
        onKeyDown={handleMenuKeyDown}
      >
        {options.map((option, index) => {
          const control = projectActionControlState(
            option.label,
            option.kind === "command" ? option.state : undefined,
          );
          const itemClassName = `${styles.menuItem} ${
            option.tone === "danger" ? styles.menuItemDanger : ""
          }`;
          return (
            <Fragment key={option.id}>
              {option.separatorBefore && index > 0 ? (
                <li role="separator" className={styles.separator} />
              ) : null}
              {option.kind === "custom" ? (
                <li role="none">
                  <div role="group" aria-label={option.label}>
                    {option.render({
                      closeMenu,
                      closeMenuWithoutFocus: () => closeMenu(false),
                      triggerEl: toggleRef.current,
                    })}
                  </div>
                </li>
              ) : (
                <li role="none">
                  {option.kind === "link" ? (
                    <a
                      href={option.href}
                      role="menuitem"
                      className={itemClassName}
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
                      onClick={(event) => {
                        event.stopPropagation();
                        if (option.disabled) {
                          event.preventDefault();
                          return;
                        }
                        const triggerEl = toggleRef.current;
                        closeMenu(option.restoreFocusOnClose !== false);
                        option.onSelect?.({ triggerEl });
                      }}
                    >
                      {control.menuLabel}
                    </a>
                  ) : (
                    <button
                      type="button"
                      role={control.menuRole}
                      aria-checked={control.menuChecked}
                      className={itemClassName}
                      disabled={option.disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        const triggerEl = toggleRef.current;
                        closeMenu(option.restoreFocusOnClose !== false);
                        option.onSelect({ triggerEl });
                      }}
                    >
                      {control.menuLabel}
                    </button>
                  )}
                </li>
              )}
            </Fragment>
          );
        })}
      </ul>
    ) : null;

  const triggerProps: ActionMenuTriggerProps = {
    ...triggerAttributes,
    ref: toggleRef,
    id: triggerId,
    "aria-haspopup": "menu",
    "aria-controls": menuOpen ? menuId : undefined,
    "aria-expanded": menuOpen,
    onClick: (event) => {
      event.stopPropagation();
      if (menuOpen) closeMenu(false);
      else openMenu();
    },
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
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
    },
  };

  return (
    <div
      className={containerClassName}
      ref={menuContainerRef}
      data-open={menuOpen ? "true" : "false"}
    >
      {renderTrigger ? (
        renderTrigger(triggerProps)
      ) : (
        <button {...triggerProps} type="button" className={styles.trigger} aria-label={label}>
          &hellip;
        </button>
      )}
      {menu && typeof document !== "undefined"
        ? createPortal(
            menu,
            resolvePortalContainer(toggleRef.current, modalToken !== null),
          )
        : null}
    </div>
  );
}
