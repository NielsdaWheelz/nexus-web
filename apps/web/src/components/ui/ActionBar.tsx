"use client";

import { Fragment, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import {
  projectActionControlState,
  type PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import styles from "./ActionBar.module.css";

/**
 * Flat toolbar of icon buttons — the inline-row sibling of {@link ActionMenu},
 * sharing the semantic action descriptor projected by {@link ActionMenu}.
 * Toggle and disclosure states map to their button ARIA; custom actions open
 * an anchored surface owned by the descriptor renderer.
 */
export default function ActionBar({
  options,
  label = "Actions",
  className,
}: {
  options: readonly PaneHeaderAction[];
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
          {option.kind === "custom" ? (
            <PopoverAction option={option} />
          ) : option.kind === "link" ? (
            <LinkAction option={option} />
          ) : (
            <ActionButton option={option} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function ActionButton({ option }: { option: Extract<PaneHeaderAction, { kind: "command" }> }) {
  const control = projectActionControlState(option.label, option.state);
  return (
    <Button
      variant={option.tone === "danger" ? "danger" : "ghost"}
      size="sm"
      iconOnly
      disabled={option.disabled}
      aria-label={option.label}
      title={option.label}
      aria-pressed={control.barPressed}
      aria-expanded={control.barExpanded}
      aria-controls={control.barControls}
      className={cx(styles.chromeAction, control.active && styles.pressed)}
      onClick={(event) => {
        event.stopPropagation();
        option.onSelect({ triggerEl: event.currentTarget });
      }}
    >
      {option.icon}
    </Button>
  );
}

function LinkAction({ option }: { option: Extract<PaneHeaderAction, { kind: "link" }> }) {
  return (
    <Button
      variant={option.tone === "danger" ? "danger" : "ghost"}
      size="sm"
      iconOnly
      asChild
      className={styles.chromeAction}
    >
      <a
        href={option.disabled ? undefined : option.href}
        aria-label={option.label}
        title={option.label}
        aria-disabled={option.disabled || undefined}
        tabIndex={option.disabled ? -1 : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (option.disabled) {
            event.preventDefault();
            return;
          }
          option.onSelect?.({ triggerEl: null });
        }}
      >
        {option.icon}
      </a>
    </Button>
  );
}

function PopoverAction({ option }: { option: Extract<PaneHeaderAction, { kind: "custom" }> }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        iconOnly
        className={styles.chromeAction}
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
        {option.render({
          closeMenu: () => setOpen(false),
          closeMenuWithoutFocus: () => setOpen(false),
          triggerEl: triggerRef.current,
        })}
      </FloatingActionSurface>
    </>
  );
}
