"use client";

import { Fragment, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import { cx } from "@/lib/ui/cx";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import styles from "./ActionBar.module.css";

/**
 * Flat toolbar of icon buttons — the inline-row sibling of {@link ActionMenu},
 * sharing the {@link ActionMenuOption} model. Each option's `label` is the
 * accessible name + tooltip; `tone="danger"` colors it; `pressed` toggles
 * aria-pressed + active styling; `separatorBefore` inserts a divider. A
 * `render` option becomes a toggle that opens an anchored popover hosting the
 * rendered content (the highlight color picker).
 */
export default function ActionBar({
  options,
  label = "Actions",
  className,
}: {
  options: ActionMenuOption[];
  label?: string;
  className?: string;
}) {
  if (options.length === 0) return null;
  return (
    <div role="group" aria-label={label} className={cx(styles.bar, className)}>
      {options.map((option, index) => (
        <Fragment key={option.id}>
          {option.separatorBefore && index > 0 ? (
            <span className={styles.separator} aria-hidden="true" />
          ) : null}
          {option.render ? (
            <PopoverAction option={option} />
          ) : (
            <ActionButton option={option} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function ActionButton({ option }: { option: ActionMenuOption }) {
  return (
    <Button
      variant={option.tone === "danger" ? "danger" : "ghost"}
      size="sm"
      iconOnly
      disabled={option.disabled}
      aria-label={option.label}
      title={option.label}
      aria-pressed={option.pressed}
      className={cx(option.pressed && styles.pressed)}
      onClick={(event) => {
        event.stopPropagation();
        option.onSelect?.({ triggerEl: event.currentTarget });
      }}
    >
      {option.icon}
    </Button>
  );
}

function PopoverAction({ option }: { option: ActionMenuOption }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { ref, style } = useAnchoredPosition(triggerRef.current, {
    enabled: open,
    placement: "below",
    align: "start",
    flip: true,
  });
  useDismissOnOutsideOrEscape({
    enabled: open,
    refs: [ref, triggerRef],
    onDismiss: () => setOpen(false),
  });

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        iconOnly
        disabled={option.disabled}
        aria-label={option.label}
        title={option.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {option.icon}
      </Button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={ref}
              style={style}
              className={styles.popover}
              role="dialog"
              aria-label={option.label}
              // Portaled child layer — never "outside" for a host popover's
              // outside-pointerdown dismissal (selection / reader-click).
              data-dismiss-ignore="true"
            >
              {option.render?.({
                closeMenu: () => setOpen(false),
                triggerEl: triggerRef.current,
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
