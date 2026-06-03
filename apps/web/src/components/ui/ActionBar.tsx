"use client";

import { Fragment, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import { cx } from "@/lib/ui/cx";
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
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {option.icon}
      </Button>
      <FloatingActionSurface
        open={open}
        anchor={triggerRef.current}
        placement="below"
        align="start"
        flip
        dismissIgnore
        additionalDismissRefs={[triggerRef]}
        className={styles.popover}
        onDismiss={() => setOpen(false)}
      >
        {option.render?.({
          closeMenu: () => setOpen(false),
          triggerEl: triggerRef.current,
        })}
      </FloatingActionSurface>
    </>
  );
}
