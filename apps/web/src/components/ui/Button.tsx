"use client";

import type { ComponentProps } from "react";
import { cx } from "@/lib/ui/cx";
import {
  buttonClassName,
  ControlContents,
  ControlTooltip,
  controlTriggerProps,
  type ControlAppearance,
  type ControlContent,
} from "./control";

export type ButtonProps = Omit<ComponentProps<"button">, "children" | "aria-label">
  & ControlAppearance & ControlContent;

/** Native command, quiet/compact by default and type=button. Busy never decides blocking. */
export default function Button(props: ButtonProps) {
  const {
    emphasis, tone, size, iconOnly, icon, tooltip: _tooltip, children, className, ref,
    "aria-label": label, type = "button", ...attributes
  } = props;
  const blocked = attributes.disabled === true || attributes["aria-disabled"] === true || attributes["aria-disabled"] === "true";
  const busy = attributes["aria-busy"] === true || attributes["aria-busy"] === "true";
  return <ControlTooltip content={props} triggerRef={ref}
    expanded={attributes["aria-expanded"] === true || attributes["aria-expanded"] === "true"}
    renderTrigger={(help) => <button
      {...attributes}
      {...controlTriggerProps({ help, attributes, blocked })}
      type={type}
      aria-label={label}
      className={cx(buttonClassName({ emphasis, tone, size, iconOnly }), className)}
    >
      <ControlContents icon={icon} busy={busy}>{children}</ControlContents>
    </button>}
  />;
}
