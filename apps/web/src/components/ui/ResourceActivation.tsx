"use client";

import type { ReactNode } from "react";
import { isNestedInteractiveTarget } from "@/lib/ui/isNestedInteractiveTarget";

export type ResourceRowPrimary =
  | {
      kind: "link";
      href: string;
      paneLabelHint?: string;
      target?: "_self" | "_blank";
      rel?: string;
      viewTransition?: "media-reader";
    }
  | {
      kind: "button";
      onActivate: () => void | Promise<void>;
      disabled?: boolean;
      busy?: boolean;
      label: string;
    }
  | { kind: "static" };

export default function ResourceActivation({
  primary,
  className,
  children,
  dataRowFocusable = true,
}: {
  primary: ResourceRowPrimary;
  className: string;
  children: ReactNode;
  dataRowFocusable?: boolean;
}) {
  if (primary.kind === "link") {
    return (
      <a
        className={className}
        data-row-focusable={dataRowFocusable ? "" : undefined}
        href={primary.href}
        data-pane-label-hint={primary.paneLabelHint}
        data-view-transition={primary.viewTransition}
        target={primary.target}
        rel={primary.rel}
      >
        {children}
      </a>
    );
  }

  if (primary.kind === "button") {
    return (
      <button
        className={className}
        data-row-focusable={dataRowFocusable ? "" : undefined}
        type="button"
        disabled={primary.disabled || primary.busy}
        aria-busy={primary.busy || undefined}
        aria-label={primary.label}
        onClick={(event) => {
          // Suppress only clicks whose nearest interactive ancestor is a nested
          // control *inside* the button; clicking the button itself (or its inert
          // content, whose nearest interactive is the button) activates the row.
          if (isNestedInteractiveTarget(event.target, event.currentTarget)) {
            return;
          }
          void primary.onActivate();
        }}
      >
        {children}
      </button>
    );
  }

  return <div className={className}>{children}</div>;
}
