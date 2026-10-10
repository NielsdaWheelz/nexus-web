"use client";

import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  projectActionControlState,
  type ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import {
  focusableElements,
  restoreFocus,
  useOverlay,
  useOverlayContainer,
} from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./ActionMenu.module.css";

/** Extra attributes for composite widgets that keep their trigger programmatic. */
type TriggerAttributes = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "tabIndex"
> &
  Partial<Record<`data-${string}`, string | undefined>>;

/** A custom trigger spreads these onto its focusable element. */
interface ActionMenuTriggerProps extends TriggerAttributes {
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
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

const ITEMS =
  '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

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
}: {
  readonly options: readonly ActionDescriptor[];
  /** Accessible name of the trigger, or of a directly anchored menu. */
  readonly label?: string;
  readonly className?: string;
  /** Reports each open and each close (an unmount while open included), once. */
  readonly onOpenChange?: (open: boolean) => void;
  readonly placement?: "below" | "above";
  readonly align?: "start" | "center" | "end";
  /** A custom trigger (e.g. an avatar); defaults to the "…" button. */
  readonly renderTrigger?: (props: ActionMenuTriggerProps) => ReactNode;
  readonly triggerAttributes?: TriggerAttributes;
  /** Shares the trigger node with another behaviour such as drag activation. */
  readonly triggerRef?: (node: HTMLButtonElement | null) => void;
  /** Keeps the trigger visible but inert while its options are unavailable. */
  readonly triggerDisabled?: boolean;
  /** The required explanation for a disabled trigger. */
  readonly triggerDisabledReason?: string;
  /** Opens at an existing target (a clicked highlight), with no trigger. */
  readonly anchored?: {
    readonly anchor: DOMRect;
    readonly onDismiss: () => void;
  };
}) {
  const [expanded, setExpanded] = useState<"first" | "last" | null>(null);
  const direct = anchored !== undefined;
  const open = direct || expanded !== null;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // An anchored menu mounts open (never on the server): what had focus then
  // (the reading area) gets it back without the reader scrolling to it.
  const [opener] = useState(() => {
    if (!direct) return null;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body
      ? { element: active, preventScroll: true as const }
      : null;
  });
  const triggerId = useId();
  const menuId = useId();
  const reasonId = useId();
  const container = useOverlayContainer();
  const menu = useAnchoredPosition<HTMLUListElement>(
    anchored?.anchor ?? trigger,
    { enabled: open && container !== null, placement, align, flip: direct },
  );

  const closeRef = useRef<(restoreFocus: boolean) => void>(() => undefined);
  const { layer } = useOverlay(open, {
    kind: "transient",
    onDismiss: (reason) => closeRef.current(reason !== "outside"),
    inside: () => [menu.ref.current, root.current],
    // A triggered menu returns to its trigger (Safari never focuses a clicked
    // button), an anchored one to its opener.
    returnFocusTo: () => trigger.current ?? opener,
  });
  // The menu's one return path (so no `returnFocus` on its layer): before a
  // chosen command runs, so whatever it opens names the trigger, not the
  // vanishing item, as its opener.
  const close = (returnFocus = true) => {
    if (returnFocus) restoreFocus(layer);
    if (anchored) anchored.onDismiss();
    else setExpanded(null);
  };
  closeRef.current = close;

  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    report.current?.(true);
    return () => report.current?.(false);
  }, [open]);

  useEffect(() => {
    if (!direct && open && options.length === 0) closeRef.current(true);
  }, [direct, open, options.length]);

  // A directly anchored menu belongs to its reading position: scrolling closes it.
  useEffect(() => {
    if (!direct) return;
    const onScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        menu.ref.current?.contains(event.target)
      ) {
        return;
      }
      closeRef.current(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("scroll", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("scroll", onScroll);
    };
  }, [direct, menu.ref]);

  // Focus the first (or last) item once, after the first placement: a moving
  // anchor never resets the keyboard position.
  const edge = expanded ?? "first";
  const hasOptions = options.length > 0;
  useEffect(() => {
    const list = menu.ref.current;
    if (!open || !menu.placed || !list) return;
    const frame = requestAnimationFrame(() => {
      const items = [...list.querySelectorAll<HTMLElement>(ITEMS)];
      const enabled = items.some(
        (item) => item.getAttribute("aria-disabled") !== "true",
      );
      const pool = enabled ? items : focusableElements(list);
      const target = pool[edge === "last" ? pool.length - 1 : 0] ?? list;
      target.focus({ preventScroll: direct });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, menu.placed, menu.ref, edge, direct, hasOptions]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    // Menu keys never reach the page's handlers: React bubbles a portaled
    // menu's keys through its owners (the linked-notes editor would take
    // Escape and Delete). Stopped at the portal container, they never reach
    // the overlay stack's document listener either, so the menu (the owner
    // while focus is in it) answers Escape itself.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    const list = event.currentTarget;
    const items = [...list.querySelectorAll<HTMLElement>(ITEMS)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === "Tab") {
      const tabbable = focusableElements(list);
      const from = event.shiftKey ? tabbable[0] : tabbable.at(-1);
      if (document.activeElement === from) {
        event.preventDefault();
        (event.shiftKey ? tabbable.at(-1) : tabbable[0])?.focus();
      }
    } else if (items.length === 0) {
      return;
    } else if (event.key === "ArrowDown") {
      go(at < 0 ? 0 : at + 1);
    } else if (event.key === "ArrowUp") {
      go(at < 0 ? -1 : at - 1);
    } else if (event.key === "Home") {
      go(0);
    } else if (event.key === "End") {
      go(-1);
    } else if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const prefix = event.key.toLocaleLowerCase();
      const ordered = [...items.slice(at + 1), ...items.slice(0, at + 1)];
      const next = ordered.find((item) =>
        item.textContent?.trim().toLocaleLowerCase().startsWith(prefix),
      );
      if (next) go(items.indexOf(next));
    }
  };

  if (!direct && !hasOptions && !triggerDisabled) return null;

  const item = (option: ActionDescriptor, index: number) => {
    const attributes = {
      "data-action-id": option.id,
      "data-action-tone": option.tone ?? "default",
      "data-action-availability": option.disabled ? "Blocked" : "Available",
    } as const;
    if (option.kind === "custom") {
      return (
        <li role="none">
          <div role="group" aria-label={option.label} {...attributes}>
            {option.render({
              closeMenu: close,
              closeMenuWithoutFocus: () => close(false),
              triggerEl: trigger.current,
            })}
          </div>
        </li>
      );
    }
    const control = projectActionControlState(
      option.label,
      option.kind === "command" ? option.state : undefined,
    );
    const reason =
      option.disabled && option.disabledReason
        ? `${menuId}-reason-${index}`
        : undefined;
    const common = {
      ...attributes,
      className: `${styles.menuItem} ${option.tone === "danger" ? styles.menuItemDanger : ""}`,
      "aria-disabled": option.disabled || undefined,
      "aria-describedby": reason,
      onKeyDown: (event: KeyboardEvent) => {
        if (option.disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
        }
      },
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        if (option.disabled) return event.preventDefault();
        const triggerEl = trigger.current;
        close(option.restoreFocusOnClose !== false);
        option.onSelect?.({ triggerEl });
      },
    };
    const body = (
      <>
        {option.icon ? (
          <span className={styles.menuItemIcon} aria-hidden="true">
            {option.icon}
          </span>
        ) : null}
        <span>{control.menuLabel}</span>
      </>
    );
    return (
      <li role="none">
        {option.kind === "link" ? (
          <a
            {...common}
            href={option.disabled ? undefined : option.href}
            role="menuitem"
            tabIndex={option.disabled ? -1 : undefined}
          >
            {body}
          </a>
        ) : (
          <button
            {...common}
            type="button"
            role={control.menuRole}
            aria-checked={control.menuChecked}
            aria-expanded={control.barExpanded}
            aria-controls={control.barControls}
          >
            {body}
          </button>
        )}
        {reason ? (
          <span id={reason} className="sr-only">
            {option.disabledReason}
          </span>
        ) : null}
      </li>
    );
  };

  const triggerProps: ActionMenuTriggerProps = {
    ...triggerAttributes,
    ref: (node) => {
      trigger.current = node;
      triggerRef?.(node);
    },
    type: "button",
    className: styles.trigger,
    id: triggerId,
    "aria-label": label,
    "aria-describedby":
      triggerDisabled && triggerDisabledReason ? reasonId : undefined,
    "aria-disabled": triggerDisabled || undefined,
    "aria-haspopup": "menu",
    "aria-controls": open ? menuId : undefined,
    "aria-expanded": open,
    onClick: (event) => {
      event.stopPropagation();
      if (triggerDisabled) return;
      if (open) close(false);
      else setExpanded("first");
    },
    onKeyDown: (event) => {
      if (triggerDisabled) return;
      const opening =
        event.key === "ArrowUp"
          ? "last"
          : ["Enter", " ", "ArrowDown"].includes(event.key)
            ? "first"
            : null;
      if (!opening) return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(opening);
    },
  };

  return (
    <div
      ref={root}
      className={[styles.container, className].filter(Boolean).join(" ")}
      data-open={open ? "true" : "false"}
    >
      {direct ? null : renderTrigger ? (
        renderTrigger(triggerProps)
      ) : (
        <button {...triggerProps}>&hellip;</button>
      )}
      {!direct && triggerDisabled && triggerDisabledReason ? (
        <span id={reasonId} className="sr-only">
          {triggerDisabledReason}
        </span>
      ) : null}
      {open && container
        ? createPortal(
            <ul
              ref={menu.ref}
              id={menuId}
              className={styles.menu}
              role="menu"
              style={menu.style}
              tabIndex={-1}
              aria-label={direct ? label : undefined}
              aria-labelledby={direct ? undefined : triggerId}
              onKeyDown={onMenuKeyDown}
            >
              {!hasOptions && triggerDisabledReason ? (
                <li role="none" className={styles.menuStatus}>
                  <span role="status">{triggerDisabledReason}</span>
                </li>
              ) : null}
              {options.map((option, index) => (
                <Fragment key={option.id}>
                  {option.separatorBefore && index > 0 ? (
                    <li role="separator" className={styles.separator} />
                  ) : null}
                  {item(option, index)}
                </Fragment>
              ))}
            </ul>,
            container,
          )
        : null}
    </div>
  );
}
