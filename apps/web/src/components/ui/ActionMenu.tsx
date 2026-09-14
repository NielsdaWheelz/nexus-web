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
import { resolveTransientPortalContainer } from "@/lib/ui/transientPortalContainer";
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
  type: "button";
  className: string;
  id: string;
  "aria-label": string;
  "aria-describedby": string | undefined;
  "aria-disabled": boolean | undefined;
  "aria-haspopup": "menu";
  "aria-controls": string | undefined;
  "aria-expanded": boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

interface ActionMenuProps {
  options: readonly ActionDescriptor[];
  /** Accessible name for the trigger or directly anchored menu. */
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
  /** Shares the native trigger node with another behavior such as drag activation. */
  triggerRef?: (node: HTMLButtonElement | null) => void;
  /** Keeps the trigger visible but inert while its options are unavailable. */
  triggerDisabled?: boolean;
  /** Required user-facing explanation for a disabled trigger. */
  triggerDisabledReason?: string;
  /** Opens directly at an existing interaction target, without another trigger. */
  anchored?: {
    readonly anchor: DOMRect;
    readonly onDismiss: () => void;
  };
}

const MENU_ITEM_SELECTOR =
  '[role="menuitem"]:not([disabled]), ' +
  '[role="menuitemcheckbox"]:not([disabled])';
const ENABLED_MENU_ITEM_SELECTOR =
  '[role="menuitem"]:not([disabled]):not([aria-disabled="true"]), ' +
  '[role="menuitemcheckbox"]:not([disabled]):not([aria-disabled="true"])';
const TABBABLE_SELECTOR = [
  'a[href]:not([aria-disabled="true"])',
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export default function ActionMenu({
  options,
  label = "Actions",
  className,
  onOpenChange,
  placement = "below",
  align = "end",
  renderTrigger,
  triggerAttributes,
  triggerRef,
  triggerDisabled = false,
  triggerDisabledReason,
  anchored,
}: ActionMenuProps) {
  const [expanded, setExpanded] = useState(false);
  const directlyAnchored = anchored !== undefined;
  const menuOpen = directlyAnchored || expanded;
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null);
  const triggerId = useId();
  const menuId = useId();
  const triggerDisabledReasonId = useId();
  const modalToken = useContainingModalLayer();
  const modalIsTopmost = useIsModalLayerTopmost(modalToken);
  const setToggleNode = useCallback(
    (node: HTMLButtonElement | null) => {
      toggleRef.current = node;
      triggerRef?.(node);
    },
    [triggerRef],
  );
  const {
    ref: menuRef,
    style: menuStyle,
    anchorRect,
  } = useAnchoredPosition<HTMLUListElement>(anchored?.anchor ?? toggleRef, {
    enabled: menuOpen && (modalToken === null || menuContainer !== null),
    placement,
    align,
    gap: 4,
    flip: directlyAnchored,
  });

  const getMenuItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
    );
  }, [menuRef]);

  const getEnabledMenuItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR),
    );
  }, [menuRef]);

  const getTabbableItems = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
    ).filter((item) => item.tabIndex >= 0);
  }, [menuRef]);

  const closeMenu = useCallback(
    (restoreFocus: boolean = true) => {
      if (anchored) {
        // Restore before dispatch so a newly opened dialog owns the next focus.
        if (restoreFocus) priorFocusRef.current?.focus({ preventScroll: true });
        anchored.onDismiss();
        return;
      }
      setExpanded(false);
      if (restoreFocus) {
        requestAnimationFrame(() => toggleRef.current?.focus());
      }
    },
    [anchored],
  );

  const openMenu = useCallback((focusTarget: "first" | "last" = "first") => {
    setInitialFocus(focusTarget);
    setExpanded(true);
  }, []);

  useEffect(() => {
    if (!directlyAnchored && menuOpen && options.length === 0) closeMenu();
  }, [closeMenu, directlyAnchored, menuOpen, options.length]);

  useEffect(() => {
    if (!directlyAnchored || !menuOpen) return;
    priorFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [directlyAnchored, menuOpen]);

  useEffect(() => {
    if (!directlyAnchored || !menuOpen) return;
    const dismissOnReaderScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) {
        return;
      }
      closeMenu(false);
    };
    window.addEventListener("scroll", dismissOnReaderScroll, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("scroll", dismissOnReaderScroll);
    return () => {
      window.removeEventListener("scroll", dismissOnReaderScroll, true);
      viewport?.removeEventListener("scroll", dismissOnReaderScroll);
    };
  }, [closeMenu, directlyAnchored, menuOpen, menuRef]);

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
    refs: [menuRef, { current: menuContainer }],
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

  const hasOptions = options.length > 0;
  useEffect(() => {
    if (!menuOpen || !anchorRect) return;

    const frame = requestAnimationFrame(() => {
      const menuItems = getMenuItems();
      const enabledMenuItems = getEnabledMenuItems();
      const tabbableItems = getTabbableItems();
      const focusable = enabledMenuItems.length > 0 ? menuItems : tabbableItems;
      const target =
        initialFocus === "last"
          ? focusable[focusable.length - 1]
          : focusable[0];
      (target ?? menuRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    getEnabledMenuItems,
    getMenuItems,
    getTabbableItems,
    initialFocus,
    menuOpen,
    anchorRect,
    hasOptions,
    menuRef,
  ]);

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
      (item) => item === document.activeElement,
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
        item.textContent?.trim().toLocaleLowerCase().startsWith(prefix),
      );
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }
  };

  if (!directlyAnchored && options.length === 0 && !triggerDisabled) return null;

  const containerClassName = [styles.container, className]
    .filter(Boolean)
    .join(" ");

  const menu = menuOpen ? (
    <ul
      ref={menuRef}
      id={menuId}
      className={styles.menu}
      role="menu"
      style={menuStyle}
      tabIndex={-1}
      aria-label={directlyAnchored ? label : undefined}
      aria-labelledby={directlyAnchored ? undefined : triggerId}
      // A portaled menu is logically inside its trigger, so an ancestor
      // dismissal owner must never treat a pointerdown here as "outside".
      data-dismiss-ignore="true"
      onKeyDown={handleMenuKeyDown}
    >
      {!hasOptions && triggerDisabledReason ? (
        <li role="none" className={styles.menuStatus}>
          <span role="status">{triggerDisabledReason}</span>
        </li>
      ) : null}
      {options.map((option, index) => {
        const control = projectActionControlState(
          option.label,
          option.kind === "command" ? option.state : undefined,
        );
        const disabledReasonId =
          option.kind !== "custom" && option.disabled && option.disabledReason
            ? `${menuId}-disabled-reason-${index}`
            : undefined;
        const itemClassName = `${styles.menuItem} ${
          option.tone === "danger" ? styles.menuItemDanger : ""
        }`;
        const semanticAttributes = {
          "data-action-id": option.id,
          "data-action-tone": option.tone ?? "default",
          "data-action-availability": option.disabled
            ? "Blocked"
            : "Available",
        } as const;
        return (
          <Fragment key={option.id}>
            {option.separatorBefore && index > 0 ? (
              <li role="separator" className={styles.separator} />
            ) : null}
            {option.kind === "custom" ? (
              <li role="none">
                <div
                  role="group"
                  aria-label={option.label}
                  {...semanticAttributes}
                >
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
                    href={option.disabled ? undefined : option.href}
                    role="menuitem"
                    {...semanticAttributes}
                    className={itemClassName}
                    aria-disabled={option.disabled || undefined}
                    aria-describedby={disabledReasonId}
                    tabIndex={option.disabled ? -1 : undefined}
                    onKeyDown={(
                      event: ReactKeyboardEvent<HTMLAnchorElement>,
                    ) => {
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
                    {option.icon ? (
                      <span className={styles.menuItemIcon} aria-hidden="true">
                        {option.icon}
                      </span>
                    ) : null}
                    <span>{control.menuLabel}</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    role={control.menuRole}
                    {...semanticAttributes}
                    aria-checked={control.menuChecked}
                    aria-expanded={control.barExpanded}
                    aria-controls={control.barControls}
                    aria-disabled={option.disabled || undefined}
                    aria-describedby={disabledReasonId}
                    className={itemClassName}
                    onKeyDown={(event) => {
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
                      option.onSelect({ triggerEl });
                    }}
                  >
                    {option.icon ? (
                      <span className={styles.menuItemIcon} aria-hidden="true">
                        {option.icon}
                      </span>
                    ) : null}
                    <span>{control.menuLabel}</span>
                  </button>
                )}
                {disabledReasonId ? (
                  <span id={disabledReasonId} className="sr-only">
                    {option.disabledReason}
                  </span>
                ) : null}
              </li>
            )}
          </Fragment>
        );
      })}
    </ul>
  ) : null;

  const triggerProps: ActionMenuTriggerProps = {
    ...triggerAttributes,
    ref: setToggleNode,
    type: "button",
    className: styles.trigger,
    id: triggerId,
    "aria-label": label,
    "aria-describedby":
      triggerDisabled && triggerDisabledReason
        ? triggerDisabledReasonId
        : undefined,
    "aria-disabled": triggerDisabled || undefined,
    "aria-haspopup": "menu",
    "aria-controls": menuOpen ? menuId : undefined,
    "aria-expanded": menuOpen,
    onClick: (event) => {
      event.stopPropagation();
      if (triggerDisabled) return;
      if (menuOpen) closeMenu(false);
      else openMenu();
    },
    onKeyDown: (event) => {
      if (triggerDisabled) return;
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
    },
  };

  return (
    <div
      className={containerClassName}
      ref={setMenuContainer}
      data-open={menuOpen ? "true" : "false"}
    >
      {directlyAnchored ? null : renderTrigger ? (
        renderTrigger(triggerProps)
      ) : (
        <button {...triggerProps}>&hellip;</button>
      )}
      {!directlyAnchored && triggerDisabled && triggerDisabledReason ? (
        <span id={triggerDisabledReasonId} className="sr-only">
          {triggerDisabledReason}
        </span>
      ) : null}
      {menu &&
      typeof document !== "undefined" &&
      (modalToken === null || menuContainer !== null)
        ? createPortal(
            menu,
            resolveTransientPortalContainer(
              toggleRef.current ?? menuContainer,
              modalToken !== null,
            ),
          )
        : null}
    </div>
  );
}
