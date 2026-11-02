"use client";

import type {
  DOMAttributes,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
  Ref,
  SyntheticEvent,
} from "react";
import { cx } from "@/lib/ui/cx";
import Tooltip, { type TooltipTriggerProps } from "./Tooltip";
import styles from "./Control.module.css";

export type ControlAppearance = {
  emphasis?: "strong";
  tone?: "danger";
  size?: "comfortable";
};

export type ControlHelp = {
  text: string;
  placement?: "below" | "right";
  openDelayMs?: number;
};

/** `reserveIcon` and `busyKey` are retired: ignored here until the last caller migrates. */
export type ControlContent = { reserveIcon?: boolean; busyKey?: unknown } & (
  | {
      iconOnly: true;
      icon: ReactElement;
      "aria-label": string;
      children?: never;
      tooltip?: Omit<ControlHelp, "text"> & { text?: string };
    }
  | {
      iconOnly?: false;
      icon?: ReactElement;
      "aria-label"?: string;
      children: ReactNode;
      tooltip?: ControlHelp;
    }
);

type Trigger = HTMLButtonElement | HTMLAnchorElement;

/**
 * Shared native-control paint and anatomy. The class recipe is pure;
 * tooltip composition keeps the same real root even when help or content changes.
 * Native roots retain operation, navigation and focus ownership.
 */
export function buttonClassName({ emphasis, tone, size, iconOnly }: ControlAppearance & { iconOnly?: boolean }): string {
  return cx(styles.control, emphasis && styles.strong, tone && styles.danger, size && styles.comfortable, iconOnly && styles.iconOnly);
}

/** The spinner mounts with `busy` and appears by css after a delay, so a fast wait paints
 * nothing and settlement needs no timer. It takes the icon's slot, or sits over a label kept at
 * width. A new subject is a keyed remount of the control. */
export function ControlContents({ icon, busy, children }: {
  icon?: ReactElement;
  reserveIcon?: boolean;
  busy: boolean;
  busyKey?: unknown;
  children?: ReactNode;
}) {
  const spinner = busy ? <span className={styles.busy} aria-hidden="true" /> : null;
  const labelled = !icon && children !== undefined;
  return <>
    {labelled ? null : <span className={cx(styles.icon, busy && styles.waiting)} aria-hidden="true">{icon}{spinner}</span>}
    {children !== undefined ? <span className={cx(styles.label, busy && labelled && styles.waiting)}>{children}</span> : null}
    {labelled ? spinner : null}
  </>;
}

export function ControlTooltip({ content, triggerRef, expanded, renderTrigger }: {
  content: ControlContent;
  triggerRef?: Ref<Trigger>;
  expanded: boolean;
  renderTrigger: (props: TooltipTriggerProps) => ReactElement;
}) {
  const help = content.iconOnly
    ? { ...content.tooltip, text: content.tooltip?.text ?? content["aria-label"] }
    : content.tooltip ?? null;
  return <Tooltip
    text={help?.text ?? ""}
    placement={help?.placement}
    openDelayMs={help?.openDelayMs}
    disabled={!help?.text || expanded}
    triggerRef={triggerRef}
    renderTrigger={renderTrigger}
  />;
}

/** Tooltip handlers precede caller handlers; blocked activation never reaches them. */
export function controlTriggerProps({ help, attributes, blocked }: {
  help: TooltipTriggerProps;
  attributes: DOMAttributes<Trigger> & { "aria-describedby"?: string };
  blocked: boolean;
}) {
  const activate = <T extends SyntheticEvent<Trigger>>(event: T, handler?: (event: T) => void) => {
    if (blocked) {
      event.preventDefault();
      event.stopPropagation();
    } else handler?.(event);
  };
  const key = (event: KeyboardEvent<Trigger>, handler?: (event: KeyboardEvent<Trigger>) => void) => {
    if (event.key === "Enter" || event.key === " ") activate(event, handler);
    else handler?.(event);
  };
  return {
    ref: help.ref,
    "aria-describedby": attributes["aria-describedby"] ?? help["aria-describedby"],
    onPointerEnter: (event: PointerEvent<Trigger>) => { help.onPointerEnter(event); attributes.onPointerEnter?.(event); },
    onPointerLeave: (event: PointerEvent<Trigger>) => { help.onPointerLeave(event); attributes.onPointerLeave?.(event); },
    onPointerDown: (event: PointerEvent<Trigger>) => { help.onPointerDown(event); attributes.onPointerDown?.(event); },
    onFocus: (event: FocusEvent<Trigger>) => { help.onFocus(event); attributes.onFocus?.(event); },
    onBlur: (event: FocusEvent<Trigger>) => { help.onBlur(event); attributes.onBlur?.(event); },
    onClickCapture: (event: MouseEvent<Trigger>) => { help.onClickCapture(event); activate(event, attributes.onClickCapture); },
    onClick: (event: MouseEvent<Trigger>) => activate(event, attributes.onClick),
    onAuxClickCapture: (event: MouseEvent<Trigger>) => activate(event, attributes.onAuxClickCapture),
    onAuxClick: (event: MouseEvent<Trigger>) => activate(event, attributes.onAuxClick),
    onKeyDownCapture: (event: KeyboardEvent<Trigger>) => key(event, attributes.onKeyDownCapture),
    onKeyDown: (event: KeyboardEvent<Trigger>) => key(event, attributes.onKeyDown),
    onKeyUpCapture: (event: KeyboardEvent<Trigger>) => key(event, attributes.onKeyUpCapture),
    onKeyUp: (event: KeyboardEvent<Trigger>) => key(event, attributes.onKeyUp),
    onKeyPressCapture: (event: KeyboardEvent<Trigger>) => key(event, attributes.onKeyPressCapture),
    onKeyPress: (event: KeyboardEvent<Trigger>) => key(event, attributes.onKeyPress),
  };
}
