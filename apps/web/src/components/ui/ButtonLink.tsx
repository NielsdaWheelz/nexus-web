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

type LinkDestination =
  | { href: string; "aria-disabled"?: boolean | "true" | "false" }
  | { href: null; "aria-disabled": true | "true" };

export type ButtonLinkProps = Omit<ComponentProps<"a">, "children" | "aria-label" | "href" | "aria-disabled">
  & LinkDestination & ControlAppearance & ControlContent;

/** Native navigation; blocked links stay mounted/named without href and keep caller tab policy. */
export default function ButtonLink(props: ButtonLinkProps) {
  const {
    emphasis, tone, size, iconOnly, icon, tooltip: _tooltip, children, className, ref, href,
    "aria-label": label, "aria-disabled": disabled, ...attributes
  } = props;
  const blocked = href === null || disabled === true || disabled === "true";
  const busy = attributes["aria-busy"] === true || attributes["aria-busy"] === "true";
  return <ControlTooltip content={props} triggerRef={ref}
    expanded={attributes["aria-expanded"] === true || attributes["aria-expanded"] === "true"}
    renderTrigger={(help) => <a
      {...attributes}
      {...controlTriggerProps({ help, attributes, blocked })}
      href={blocked ? undefined : href}
      role={blocked ? "link" : attributes.role}
      tabIndex={attributes.tabIndex ?? (blocked ? 0 : undefined)}
      aria-label={label}
      aria-disabled={blocked || disabled}
      className={cx(buttonClassName({ emphasis, tone, size, iconOnly }), className)}
    >
      <ControlContents icon={icon} busy={busy}>{children}</ControlContents>
    </a>}
  />;
}
