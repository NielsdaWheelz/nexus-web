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
 * `showLabels` adds each action's label beside its icon at natural width.
 * Toggle and disclosure states map to their button ARIA; custom actions open
 * an anchored surface owned by the descriptor renderer.
 */
export default function ActionBar({
  options,
  label = "Actions",
  showLabels = false,
  className,
}: {
  options: readonly PaneHeaderAction[];
  label?: string;
  showLabels?: boolean;
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
            <PopoverAction option={option} showLabels={showLabels} />
          ) : option.kind === "link" ? (
            <LinkAction option={option} showLabels={showLabels} />
          ) : (
            <ActionButton option={option} showLabels={showLabels} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function ActionButton({
  option,
  showLabels,
}: {
  option: Extract<PaneHeaderAction, { kind: "command" }>;
  showLabels: boolean;
}) {
  const control = projectActionControlState(option.label, option.state);
  return (
    <Button
      variant={option.tone === "danger" ? "danger" : "ghost"}
      size="sm"
      iconOnly={!showLabels}
      leadingIcon={showLabels ? option.icon : undefined}
      disabled={option.disabled}
      aria-label={option.label}
      title={control.menuLabel}
      aria-pressed={control.barPressed}
      aria-expanded={control.barExpanded}
      aria-controls={control.barControls}
      data-action-id={option.id}
      className={cx(
        styles.chromeAction,
        !showLabels && styles.square,
        control.active && styles.pressed,
      )}
      onClick={(event) => {
        event.stopPropagation();
        option.onSelect({ triggerEl: event.currentTarget });
      }}
    >
      {showLabels ? option.label : option.icon}
    </Button>
  );
}

function LinkAction({
  option,
  showLabels,
}: {
  option: Extract<PaneHeaderAction, { kind: "link" }>;
  showLabels: boolean;
}) {
  return (
    <Button
      variant={option.tone === "danger" ? "danger" : "ghost"}
      size="sm"
      iconOnly={!showLabels}
      asChild
      className={cx(styles.chromeAction, !showLabels && styles.square)}
    >
      <a
        data-action-id={option.id}
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
        {showLabels ? option.label : null}
      </a>
    </Button>
  );
}

function PopoverAction({
  option,
  showLabels,
}: {
  option: Extract<PaneHeaderAction, { kind: "custom" }>;
  showLabels: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        iconOnly={!showLabels}
        leadingIcon={showLabels ? option.icon : undefined}
        className={cx(styles.chromeAction, !showLabels && styles.square)}
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
        {showLabels ? option.label : option.icon}
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
