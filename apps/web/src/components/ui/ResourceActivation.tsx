"use client";

import type { ReactNode } from "react";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import { isNestedInteractiveTarget } from "@/lib/ui/isNestedInteractiveTarget";

export type ResourceRowPrimary =
  | {
      kind: "link";
      href: string;
      paneLabelHint?: string;
      target?: "_self" | "_blank";
      rel?: string;
      viewTransition?: "media-reader";
      secondaryActivation?: WorkspaceSecondaryActivation;
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
}: {
  primary: ResourceRowPrimary;
  className: string;
  children: ReactNode;
}) {
  if (primary.kind === "link") {
    const secondaryActivation = primary.secondaryActivation;
    return (
      <a
        className={className}
        data-row-focusable=""
        href={primary.href}
        data-pane-label-hint={primary.paneLabelHint}
        data-view-transition={primary.viewTransition}
        data-pane-secondary-surface={secondaryActivation?.surfaceId}
        data-pane-secondary-activation={secondaryActivation?.kind}
        data-pane-dossier-revision={
          secondaryActivation?.kind === "DossierRevision"
            ? secondaryActivation.revisionRef
            : undefined
        }
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
        data-row-focusable=""
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
